/**
 * Child-process plumbing for the agent CLIs. Uses node:child_process, which
 * Bun implements (verified under `bun` and in a `bun build --compile` binary).
 */
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface SpawnedAgent {
  child: ChildProcessWithoutNullStreams;
  /** Resolves once the process has exited (code, signal). Never rejects. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>;
  /** Last ~8 KB of stderr, for crash notices. */
  stderrTail(): string;
  /** Write one JSON message as a line. Returns false if stdin is gone (and reports it through onInputLost). */
  writeJson(msg: unknown): boolean;
  /** Close stdin, then SIGTERM the process group, then SIGKILL. Resolves when exited. */
  kill(graceMs?: number): Promise<void>;
}

const STDERR_KEEP = 8192;
const INPUT_LOST_GRACE_MS = 300;

export function spawnAgent(
  bin: string,
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    onLine: (value: unknown, raw: string) => void;
    /**
     * The process is still running but no longer takes input (its stdin closed
     * or broke): nothing sent to it arrives. Not called for a process that
     * exits within a moment of losing its input; `exited` reports that one.
     */
    onInputLost?: () => void;
  },
): SpawnedAgent {
  // detached => own process group, so dispose() can take the agent's tool
  // subprocesses (shells, test runners) down with it.
  const child = spawn(bin, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let stderr = '';
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null; error?: Error } | undefined;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(
    (resolve) => {
      let spawnError: Error | undefined;
      child.once('error', (err) => {
        spawnError = err;
        // ENOENT etc: 'exit' may never fire.
        if (child.pid === undefined) {
          exitInfo = { code: null, signal: null, error: err };
          resolve(exitInfo);
        }
      });
      child.once('close', (code, signal) => {
        exitInfo = { code, signal, error: spawnError };
        resolve(exitInfo);
      });
    },
  );

  const decoder = new StringDecoder('utf8');
  let buf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buf += decoder.write(chunk);
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue; // not a protocol line (stray log output)
      }
      opts.onLine(value, line);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
    if (stderr.length > STDERR_KEEP * 2) stderr = stderr.slice(-STDERR_KEEP);
  });
  let inputLost = false;
  const loseInput = (): void => {
    if (inputLost || exitInfo) return;
    inputLost = true;
    // A process that is exiting breaks the pipe too: give 'close' a moment to arrive first.
    const grace = new Promise<void>((resolve) => setTimeout(resolve, INPUT_LOST_GRACE_MS));
    void Promise.race([exited, grace]).then(() => {
      if (!exitInfo) opts.onInputLost?.();
    });
  };
  // A dead pipe must not crash the daemon.
  child.stdin.on('error', loseInput);

  const signalGroup = (sig: NodeJS.Signals): void => {
    if (child.pid === undefined || exitInfo) return;
    try {
      if (process.platform === 'win32') child.kill(sig);
      else process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        // already gone
      }
    }
  };

  return {
    child,
    exited,
    stderrTail: () => stderr.slice(-STDERR_KEEP),
    writeJson(msg) {
      if (exitInfo) return false;
      if (inputLost || child.stdin.destroyed || !child.stdin.writable) {
        loseInput();
        return false;
      }
      child.stdin.write(`${JSON.stringify(msg)}\n`);
      return true;
    },
    async kill(graceMs = 1500) {
      if (exitInfo || child.pid === undefined) {
        await exited;
        return;
      }
      child.stdin.end();
      const t1 = setTimeout(() => signalGroup('SIGTERM'), Math.min(graceMs, 300));
      const t2 = setTimeout(() => signalGroup('SIGKILL'), graceMs + 1500);
      await exited;
      clearTimeout(t1);
      clearTimeout(t2);
      // Tool subprocesses may outlive the agent itself; sweep the group.
      if (process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // group already empty
        }
      }
    },
  };
}

/** Run `bin args` and return trimmed stdout, or undefined on any failure. */
export function runQuick(bin: string, args: string[], timeoutMs = 5000): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(bin, args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout) => {
        resolve(err ? undefined : stdout.trim());
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** Environment for an agent child: the daemon's env plus overrides, minus markers that confuse nested CLIs. */
export function childEnv(extra: NodeJS.ProcessEnv | undefined, drop: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of drop) delete env[k];
  return env;
}
