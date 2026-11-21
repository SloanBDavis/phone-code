/**
 * Spawns and controls a real phone-code daemon for one test file: its own
 * temp state directory, HOME, project folder and the scripted fake agents.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { num, parse, record, str } from './json.ts';

export const REPO = resolve(import.meta.dirname, '..', '..');
const CLI = join(REPO, 'packages/daemon/src/cli.ts');
const FAKES = join(REPO, 'e2e/fakes');

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
  /**
   * Serve plain http on the network (`--insecure`), so the phone loads the app
   * from the machine's LAN address: a non-secure context, like an iPhone on
   * Wi-Fi without https (no service worker, push or camera).
   */
  insecure?: boolean;
}

/** How to (re)start the process: `local: false` drops `--local` (tailscale auto-setup). */
export interface LaunchOptions {
  local?: boolean;
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
      FAKE_ACP_HOME: join(this.root, 'fake-acp'),
      ...(process.env['E2E_WEB_DIR'] === undefined ? {} : { PHONECODE_WEB_DIR: process.env['E2E_WEB_DIR'] }),
      ...this.opts.env,
    };
  }

  private async launch(opts: LaunchOptions = {}): Promise<void> {
    const mode =
      this.opts.insecure === true ? ['--insecure', '--no-qr'] : opts.local === false ? [] : ['--local'];
    const proc = spawn('bun', [CLI, ...mode, '--port', String(this.port)], {
      cwd: this.userHome,
      env: { ...this.env(), ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.exited = new Promise((ok) => proc.once('exit', () => ok()));
    const ready = await new Promise<unknown>((ok, fail) => {
      let buf = '';
      const timer = setTimeout(() => fail(new Error(`daemon did not start:\n${this.output}`)), 15_000);
      proc.stdout.on('data', (chunk: Buffer) => {
        const s = chunk.toString();
        this.output += s;
        buf += s;
        const m = /PHONECODE_READY (\{.*\})\n/.exec(buf);
        if (m?.[1] !== undefined) {
          clearTimeout(timer);
          ok(parse(m[1]));
        }
      });
      proc.stderr.on('data', (chunk: Buffer) => {
        this.output += chunk.toString();
      });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        fail(new Error(`daemon exited with ${code}:\n${this.output}`));
      });
    });
    if (num(ready, 'port') !== this.port) throw new Error(`daemon moved to port ${num(ready, 'port')}`);
    this.url = str(ready, 'url');
    this.pairCode = str(ready, 'pairCode');
    this.pairUrl = str(ready, 'pairUrl');
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

  /** Crash: SIGKILL, nothing gets flushed. */
  async kill(): Promise<void> {
    const p = this.proc;
    if (p === undefined) return;
    this.proc = undefined;
    if (p.exitCode === null) p.kill('SIGKILL');
    await this.exited;
  }

  /**
   * Stop, then start with different options on the same port and state. The
   * returned promise resolves at PHONECODE_READY; the process is already
   * running (and may already serve HTTP) before that.
   */
  async relaunch(opts: LaunchOptions): Promise<{ ready: Promise<void> }> {
    await this.stop();
    const ready = this.launch(opts);
    ready.catch(() => undefined);
    return { ready };
  }

  async dispose(): Promise<void> {
    await this.stop();
    rmSync(this.root, { recursive: true, force: true });
  }

  private control(): { port: number; token: string } {
    const v = parse(readFileSync(join(this.home, 'control.json'), 'utf8'));
    return { port: num(v, 'port'), token: str(v, 'token') };
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
    const r = await this.call('POST', '/_control/pair');
    return { code: str(r, 'code'), pairUrl: str(r, 'pairUrl') };
  }

  async devices(): Promise<Array<{ id: string; name: string }>> {
    const list = record(await this.call('GET', '/_control/devices'))['devices'];
    return (Array.isArray(list) ? list : []).map((d) => ({ id: str(d, 'id'), name: str(d, 'name') }));
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

  /** Creates `HOME/<name>` (a fresh project folder for one test) and returns `name`. */
  folder(name: string): string {
    mkdirSync(join(this.userHome, name), { recursive: true });
    return name;
  }

  /** Is the daemon process still alive? */
  get alive(): boolean {
    return this.proc !== undefined && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  /** Pair over HTTP, as a script would. */
  async pairToken(): Promise<string> {
    return (await this.pairDevice()).token;
  }

  /** Pair over HTTP with a fresh code; the new device's id and token. */
  async pairDevice(): Promise<{ deviceId: string; token: string }> {
    const { code } = await this.newPairCode();
    const res = await this.pairWith(code);
    if (res.status !== 200) throw new Error(`pairing failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { deviceId: str(res.body, 'deviceId'), token: str(res.body, 'token') };
  }

  /** POST /api/pair with `code` (and extra headers, e.g. what a proxy would add). */
  async pairWith(
    code: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${this.url}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ code, deviceName: 'script' }),
    });
    return { status: res.status, body: await res.json() };
  }

  /** POST /api/handoff with a device token: a fresh handoff code. */
  async handoff(token: string): Promise<string> {
    const res = await fetch(`${this.url}/api/handoff`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status !== 200) throw new Error(`handoff failed: ${res.status}`);
    return str(await res.json(), 'code');
  }
}
