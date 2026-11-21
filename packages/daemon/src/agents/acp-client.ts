/**
 * The client half of ACP that an agent may call back into: `fs/read_text_file`,
 * `fs/write_text_file` and the `terminal/*` methods.
 *
 * File access is confined to the session's working directory: the path must
 * be absolute and, after resolving symlinks (of the file, or of its nearest
 * existing parent for a new file), lie inside the cwd's real path. Anything
 * else is refused with a JSON-RPC error that says why, and the agent can fall
 * back to its own tools (which go through its own permission prompts).
 * Reads and writes are capped at 10 MB.
 *
 * Terminals run as child processes of the daemon in their own process group
 * (no PTY; agents read the output as text). `command` with no `args` and any
 * whitespace runs through `/bin/sh -c`, as Zed does; otherwise it is spawned
 * directly. Output is kept up to `outputByteLimit` (default 1 MB), trimmed from
 * the front. dispose() kills every terminal's process group.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { arr, isRec, num, str, type Rec } from './shared/common.ts';

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_FILE = 10 * 1024 * 1024;
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;

async function realOrSelf(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/** Real path of `p`, or of its nearest existing ancestor joined with the rest. */
async function realTarget(p: string): Promise<string> {
  let cur = p;
  const rest: string[] = [];
  for (;;) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- walks up one parent at a time
      const real = await realpath(cur);
      return path.join(real, ...rest.toReversed());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

interface Term {
  id: string;
  proc: ChildProcess;
  output: string;
  truncated: boolean;
  limit: number;
  exit?: { exitCode: number | null; signal: string | null };
  exited: Promise<{ exitCode: number | null; signal: string | null }>;
}

export class AcpClientSide {
  private readonly terms = new Map<string, Term>();
  private nextTerm = 1;
  private rootReal: Promise<string> | undefined;

  constructor(
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    /** Called whenever a terminal's output or exit status changes. */
    private readonly onTerminal: (id: string, output: string, exitCode: number | null | undefined) => void,
  ) {}

  private async confine(p: unknown, forWrite: boolean): Promise<string> {
    if (typeof p !== 'string' || !path.isAbsolute(p))
      throw new RpcError(-32602, 'path must be an absolute path');
    this.rootReal ??= realOrSelf(this.cwd);
    const root = await this.rootReal;
    const target = forWrite ? await realTarget(path.normalize(p)) : await realOrSelf(path.normalize(p));
    if (!inside(root, target))
      throw new RpcError(
        -32602,
        `phone-code only lets agents ${forWrite ? 'write' : 'read'} files inside the session folder (${this.cwd}); ${p} is outside it`,
      );
    return target;
  }

  async readTextFile(params: Rec): Promise<{ content: string }> {
    const file = await this.confine(params.path, false);
    let st;
    try {
      st = await stat(file);
    } catch {
      throw new RpcError(-32002, `File not found: ${str(params.path) ?? ''}`);
    }
    if (!st.isFile()) throw new RpcError(-32602, `Not a file: ${str(params.path) ?? ''}`);
    if (st.size > MAX_FILE) throw new RpcError(-32602, 'File is larger than 10 MB');
    let content = await readFile(file, 'utf8');
    const line = num(params.line);
    const limit = num(params.limit);
    if (line !== undefined || limit !== undefined) {
      const lines = content.split('\n');
      const start = Math.max(0, (line ?? 1) - 1);
      content = lines.slice(start, limit !== undefined ? start + Math.max(0, limit) : undefined).join('\n');
    }
    return { content };
  }

  async writeTextFile(params: Rec): Promise<Rec> {
    const content = str(params.content);
    if (content === undefined) throw new RpcError(-32602, 'content must be a string');
    if (content.length > MAX_FILE) throw new RpcError(-32602, 'Content is larger than 10 MB');
    const file = await this.confine(params.path, true);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
    return {};
  }

  // ------------------------------------------------------------- terminals

  createTerminal(params: Rec): { terminalId: string } {
    const command = str(params.command);
    if (!command) throw new RpcError(-32602, 'command is required');
    const args = arr(params.args).filter((a): a is string => typeof a === 'string');
    const env: NodeJS.ProcessEnv = { ...this.env };
    for (const v of arr(params.env)) {
      if (isRec(v) && typeof v.name === 'string' && typeof v.value === 'string') env[v.name] = v.value;
    }
    const cwd = str(params.cwd) ?? this.cwd;
    if (!path.isAbsolute(cwd)) throw new RpcError(-32602, 'cwd must be an absolute path');
    const limit = Math.max(1024, num(params.outputByteLimit) ?? DEFAULT_OUTPUT_LIMIT);
    const viaShell = args.length === 0 && /\s/.test(command) && process.platform !== 'win32';
    const proc = spawn(viaShell ? '/bin/sh' : command, viaShell ? ['-c', command] : args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const id = `term_${this.nextTerm++}`;
    const term: Term = {
      id,
      proc,
      output: '',
      truncated: false,
      limit,
      exited: new Promise((resolve) => {
        let done = false;
        const finish = (exitCode: number | null, signal: string | null): void => {
          if (done) return;
          done = true;
          term.exit = { exitCode, signal };
          this.onTerminal(id, term.output, exitCode);
          resolve(term.exit);
        };
        proc.once('error', (err) => {
          term.output += `${err.message}\n`;
          finish(127, null);
        });
        proc.once('close', (code, signal) => finish(code, signal));
      }),
    };
    const append = (chunk: Buffer): void => {
      term.output += chunk.toString('utf8');
      if (Buffer.byteLength(term.output) > term.limit) {
        // Trim from the front, on a character boundary.
        let cut = term.output.length - term.limit;
        while (cut < term.output.length && Buffer.byteLength(term.output.slice(cut)) > term.limit)
          cut += 1024;
        term.output = term.output.slice(cut);
        term.truncated = true;
      }
      this.onTerminal(id, term.output, undefined);
    };
    proc.stdout.on('data', append);
    proc.stderr.on('data', append);
    this.terms.set(id, term);
    return { terminalId: id };
  }

  private term(params: Rec): Term {
    const t = this.terms.get(str(params.terminalId) ?? '');
    if (!t) throw new RpcError(-32002, 'Unknown terminal');
    return t;
  }

  terminalOutput(params: Rec): Rec {
    const t = this.term(params);
    return { output: t.output, truncated: t.truncated, ...(t.exit ? { exitStatus: t.exit } : {}) };
  }

  async waitForExit(params: Rec): Promise<Rec> {
    const t = this.term(params);
    return { ...(await t.exited) };
  }

  killTerminal(params: Rec): Rec {
    this.signal(this.term(params), 'SIGTERM');
    return {};
  }

  releaseTerminal(params: Rec): Rec {
    const t = this.term(params);
    this.signal(t, 'SIGKILL');
    this.terms.delete(t.id);
    return {};
  }

  private signal(t: Term, sig: NodeJS.Signals): void {
    if (t.exit || t.proc.pid === undefined) return;
    try {
      if (process.platform === 'win32') t.proc.kill(sig);
      else process.kill(-t.proc.pid, sig);
    } catch {
      try {
        t.proc.kill(sig);
      } catch {
        // gone
      }
    }
    if (sig === 'SIGTERM') {
      const timer = setTimeout(() => this.signal(t, 'SIGKILL'), 2000);
      void t.exited.then(() => clearTimeout(timer));
    }
  }

  /** Kill every terminal (their whole process groups). */
  async dispose(): Promise<void> {
    const all = [...this.terms.values()];
    this.terms.clear();
    for (const t of all) this.signal(t, 'SIGKILL');
    await Promise.all(all.map((t) => Promise.race([t.exited, new Promise((r) => setTimeout(r, 2000))])));
  }

  /** Handle one client-side request. Throws RpcError for bad requests. */
  async handle(method: string, params: Rec): Promise<unknown> {
    switch (method) {
      case 'fs/read_text_file':
        return this.readTextFile(params);
      case 'fs/write_text_file':
        return this.writeTextFile(params);
      case 'terminal/create':
        return this.createTerminal(params);
      case 'terminal/output':
        return this.terminalOutput(params);
      case 'terminal/wait_for_exit':
        return this.waitForExit(params);
      case 'terminal/kill':
        return this.killTerminal(params);
      case 'terminal/release':
        return this.releaseTerminal(params);
      default:
        throw new RpcError(-32601, `phone-code does not implement ${method}`);
    }
  }
}

export function isClientSideMethod(method: string): boolean {
  return method.startsWith('fs/') || method.startsWith('terminal/');
}
