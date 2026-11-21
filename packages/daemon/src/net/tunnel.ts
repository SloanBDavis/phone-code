import { log } from '../log.ts';

export interface Tunnel {
  url: string;
  stop(): void;
}

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** Start a Cloudflare quick tunnel to the local port and wait for its URL. */
export async function startQuickTunnel(port: number, timeoutMs = 30_000): Promise<Tunnel> {
  const bin = Bun.which('cloudflared');
  if (bin === null) {
    throw new Error('cloudflared is not installed (https://developers.cloudflare.com/cloudflared/)');
  }
  const proc = Bun.spawn([bin, 'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
    stdout: 'ignore',
    stderr: 'pipe',
  });
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    if (proc.exitCode === null) proc.kill('SIGTERM');
  };
  void proc.exited.then((code) => {
    if (!stopped) log.warn(`cloudflared exited (${code}); the tunnel URL no longer works`);
    return undefined;
  });

  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const timer = setTimeout(
    () => reject(new Error('timed out waiting for the cloudflared tunnel URL')),
    timeoutMs,
  );
  // Read stderr until the URL shows up, then keep draining so cloudflared never blocks on a full pipe.
  void (async (): Promise<void> => {
    const decoder = new TextDecoder();
    let buffered = '';
    let found = false;
    for await (const chunk of proc.stderr) {
      if (found) continue;
      buffered = (buffered + decoder.decode(chunk, { stream: true })).slice(-8000);
      const match = TUNNEL_URL.exec(buffered);
      if (match !== null) {
        found = true;
        resolve(match[0]);
      }
    }
    reject(new Error('cloudflared exited before reporting a URL'));
  })();

  try {
    return { url: await promise, stop };
  } catch (err) {
    stop();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
