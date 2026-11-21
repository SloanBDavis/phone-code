import type { Subprocess } from 'bun';
import { log } from '../log.ts';

export interface Tunnel {
  url: string;
  stop(): void;
}

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export function hasCloudflared(): boolean {
  return Bun.which('cloudflared') !== null;
}

/**
 * Watch a helper process's output streams until `pattern` appears, then keep
 * draining them so the process never blocks on a full pipe. The returned
 * Tunnel stops the process with `stopSignal`.
 */
export async function waitForUrl(
  name: string,
  proc: Subprocess<'ignore', 'pipe' | 'ignore', 'pipe'>,
  pattern: RegExp,
  timeoutMs: number,
  stopSignal: NodeJS.Signals = 'SIGTERM',
): Promise<Tunnel> {
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    if (proc.exitCode === null) proc.kill(stopSignal);
  };
  void proc.exited.then((code) => {
    if (!stopped) log.warn(`${name} exited (${code}); its URL no longer works`);
    return undefined;
  });
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const timer = setTimeout(() => reject(new Error(`timed out waiting for the ${name} URL`)), timeoutMs);
  let output = '';
  const watch = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output = (output + decoder.decode(chunk, { stream: true })).slice(-8000);
      const match = pattern.exec(output);
      if (match !== null) resolve(match[0]);
    }
  };
  const streams = [proc.stderr, ...(proc.stdout instanceof ReadableStream ? [proc.stdout] : [])];
  void Promise.all(streams.map(watch)).then(() => {
    const tail = output.trim().split('\n').slice(-3).join(' | ');
    reject(new Error(`${name} exited before reporting a URL${tail === '' ? '' : `: ${tail}`}`));
    return undefined;
  });
  try {
    return { url: await promise, stop };
  } catch (err) {
    stop();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Start a Cloudflare quick tunnel to the local port and wait for its URL. */
export function startQuickTunnel(port: number, timeoutMs = 30_000): Promise<Tunnel> {
  const bin = Bun.which('cloudflared');
  if (bin === null) {
    return Promise.reject(
      new Error('cloudflared is not installed (https://developers.cloudflare.com/cloudflared/)'),
    );
  }
  const proc = Bun.spawn([bin, 'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  return waitForUrl('cloudflared', proc, TUNNEL_URL, timeoutMs);
}
