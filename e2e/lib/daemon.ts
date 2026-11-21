/**
 * Spawns and controls a real phone-code daemon for one test file: its own
 * temp state directory, HOME, project folder and the scripted fake agents.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const REPO = resolve(import.meta.dirname, '..', '..');
const CLI = join(REPO, 'packages/daemon/src/cli.ts');
const FAKES = join(REPO, 'e2e/fakes');

interface Ready {
  url: string;
  port: number;
  pairCode: string;
  pairUrl: string;
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => ok(port));
    });
  });
}

export interface DaemonOptions {
  /** Extra environment for the daemon (and through it, the fake agents). */
  env?: Record<string, string>;
}

export class Daemon {
  readonly root: string;
  /** PHONECODE_HOME */
  readonly home: string;
  /** HOME of the daemon and its children. */
  readonly userHome: string;
  /** A project folder inside HOME that tests open sessions in. */
  readonly project: string;
  port = 0;
  url = '';
  /** The pairing code printed at startup. */
  pairCode = '';
  pairUrl = '';
  private proc: ChildProcess | undefined;
  private exited: Promise<void> = Promise.resolve();
  output = '';

  private constructor(private readonly opts: DaemonOptions) {
    this.root = mkdtempSync(join(tmpdir(), 'phonecode-e2e-'));
    this.home = join(this.root, 'state');
    this.userHome = join(this.root, 'home');
    this.project = join(this.userHome, 'project');
    mkdirSync(join(this.project, 'src'), { recursive: true });
    mkdirSync(join(this.userHome, 'other'), { recursive: true });
    writeFileSync(join(this.project, 'README.md'), '# project\n');
    writeFileSync(join(this.userHome, '.bashrc'), "PS1='$ '\n");
    writeFileSync(join(this.userHome, '.bash_profile'), '. ~/.bashrc\n');
  }

  static async start(opts: DaemonOptions = {}): Promise<Daemon> {
    const d = new Daemon(opts);
    d.port = await freePort();
    await d.launch();
    return d;
  }

  env(): Record<string, string> {
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith('PHONECODE_') && !k.startsWith('CLAUDE') && !k.startsWith('CODEX'))
        base[k] = v;
    }
    return {
      ...base,
      HOME: this.userHome,
      SHELL: '/bin/bash',
      USER: 'tester',
      PHONECODE_HOME: this.home,
      PHONECODE_JSON: '1',
      PHONECODE_CLAUDE_BIN: join(FAKES, 'fake-claude.mjs'),
      PHONECODE_CODEX_BIN: join(FAKES, 'fake-codex.mjs'),
      CLAUDE_CONFIG_DIR: join(this.userHome, '.claude'),
      CODEX_HOME: join(this.userHome, '.codex'),
      FAKE_SPEED: '2',
      ...this.opts.env,
    };
  }

  private async launch(): Promise<void> {
    const proc = spawn('bun', [CLI, '--local', '--port', String(this.port)], {
      cwd: this.userHome,
      env: this.env(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.exited = new Promise((ok) => proc.once('exit', () => ok()));
    const ready = await new Promise<Ready>((ok, fail) => {
      let buf = '';
      const timer = setTimeout(() => fail(new Error(`daemon did not start:\n${this.output}`)), 15_000);
      proc.stdout?.on('data', (chunk: Buffer) => {
        const s = chunk.toString();
        this.output += s;
        buf += s;
        const m = /PHONECODE_READY (\{.*\})\n/.exec(buf);
        if (m?.[1] !== undefined) {
          clearTimeout(timer);
          ok(JSON.parse(m[1]) as Ready);
        }
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        this.output += chunk.toString();
      });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        fail(new Error(`daemon exited with ${code}:\n${this.output}`));
      });
    });
    if (ready.port !== this.port) throw new Error(`daemon moved to port ${ready.port}`);
    this.url = ready.url;
    this.pairCode = ready.pairCode;
    this.pairUrl = ready.pairUrl;
  }

  /** Stop gracefully (SIGTERM), as Ctrl-C would. */
  async stop(): Promise<void> {
    const p = this.proc;
    if (p === undefined) return;
    this.proc = undefined;
    if (p.exitCode === null) p.kill('SIGTERM');
    const killer = setTimeout(() => p.kill('SIGKILL'), 8000);
    await this.exited;
    clearTimeout(killer);
  }

  /** Stop and start again on the same port with the same state. */
  async restart(): Promise<void> {
    await this.stop();
    await this.launch();
  }

  async dispose(): Promise<void> {
    await this.stop();
    rmSync(this.root, { recursive: true, force: true });
  }

  private control(): { port: number; token: string } {
    const v = JSON.parse(readFileSync(join(this.home, 'control.json'), 'utf8')) as {
      port: number;
      token: string;
    };
    return v;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const c = this.control();
    const res = await fetch(`http://127.0.0.1:${c.port}${path}`, {
      method,
      headers: { 'x-phonecode-control': c.token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`control ${path}: ${res.status}`);
    return res.json();
  }

  /** A fresh single-use pairing code, like `phonecode pair`. */
  async newPairCode(): Promise<{ code: string; pairUrl: string }> {
    return (await this.call('POST', '/_control/pair')) as { code: string; pairUrl: string };
  }

  async devices(): Promise<Array<{ id: string; name: string }>> {
    const r = (await this.call('GET', '/_control/devices')) as { devices: Array<{ id: string; name: string }> };
    return r.devices;
  }

  /** Runs the real CLI (`phonecode <args>`) against this daemon's state. */
  cli(...args: string[]): Promise<{ code: number | null; out: string }> {
    return new Promise((ok) => {
      const p = spawn('bun', [CLI, ...args], { env: this.env(), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', (c: Buffer) => (out += c.toString()));
      p.stderr.on('data', (c: Buffer) => (out += c.toString()));
      p.once('exit', (code) => ok({ code, out }));
    });
  }

  /** Is the daemon process still alive? */
  get alive(): boolean {
    return this.proc !== undefined && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  /** Pair over HTTP, as a script would. */
  async pairToken(): Promise<string> {
    const { code } = await this.newPairCode();
    const res = await fetch(`${this.url}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceName: 'script' }),
    });
    const j = (await res.json()) as { token: string };
    return j.token;
  }
}
