#!/usr/bin/env bun
/**
 * End-to-end smoke test of a compiled phonecode binary, run from an empty
 * temporary directory so nothing from the repo can leak in:
 *
 *   1. start it with --local and a throwaway PHONECODE_HOME
 *   2. load the pairing page and one hashed asset (embedded web app)
 *   3. pair over HTTP, open the websocket, start a terminal running /bin/sh,
 *      type a command and see its output (pty)
 *   4. resubscribe and check the snapshot contains that output (screen worker)
 *   5. stop it with SIGINT and expect exit code 0
 *
 * Usage: bun scripts/smoke-binary.ts path/to/phonecode
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const arg = process.argv[2];
if (arg === undefined) {
  console.error('usage: bun scripts/smoke-binary.ts path/to/phonecode');
  process.exit(2);
}
const bin = resolve(arg);
const dir = mkdtempSync(join(tmpdir(), 'phonecode-smoke-'));

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok   ${what}`);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const proc = Bun.spawn([bin, '--local', '--no-qr', '--port', '17999'], {
  cwd: dir,
  env: { ...process.env, PHONECODE_HOME: join(dir, 'home'), PHONECODE_JSON: '1' },
  stdout: 'pipe',
  stderr: 'inherit',
  stdin: 'ignore',
});

async function readyLine(): Promise<{ port: number; pairCode: string }> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`phonecode exited before it was ready:\n${buf}`);
    buf += decoder.decode(value);
    const m = /PHONECODE_READY (\{.*\})\n/.exec(buf);
    if (m?.[1] === undefined) continue;
    reader.releaseLock();
    const ready: unknown = JSON.parse(m[1]);
    if (!isRecord(ready) || typeof ready['port'] !== 'number' || typeof ready['pairCode'] !== 'string') {
      throw new Error(`unexpected ready line ${m[1]}`);
    }
    return { port: ready['port'], pairCode: ready['pairCode'] };
  }
}

function terminalRoundTrip(port: number, token: string): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const send = (msg: Record<string, unknown>): void => ws.send(JSON.stringify(msg));
  let out = '';
  let resubscribed = false;
  return new Promise<void>((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`terminal timed out; output so far: ${JSON.stringify(out)}`)),
      15_000,
    );
    const finish = (err?: Error): void => {
      clearTimeout(timer);
      ws.close();
      if (err === undefined) done();
      else fail(err);
    };
    ws.addEventListener('open', () => send({ t: 'hello', v: 1, token }));
    ws.addEventListener('message', (e) => {
      const m: unknown = JSON.parse(String(e.data));
      if (!isRecord(m)) return;
      const sessionId = typeof m['sessionId'] === 'string' ? m['sessionId'] : '';
      const data = typeof m['data'] === 'string' ? m['data'] : '';
      if (m['t'] === 'ready') {
        check(true, 'websocket hello');
        send({
          t: 'session.create',
          id: '1',
          params: { kind: 'terminal', cols: 80, rows: 24, command: '/bin/sh' },
        });
      } else if (m['t'] === 'res' && m['id'] === '1') {
        const session = m['data'];
        if (m['ok'] !== true || !isRecord(session) || typeof session['id'] !== 'string') {
          finish(new Error(`session.create failed: ${JSON.stringify(m)}`));
          return;
        }
        const id = session['id'];
        send({ t: 'sub', sessionId: id });
        setTimeout(() => send({ t: 'term.input', sessionId: id, data: 'echo smoke-$((6*7))\r' }), 300);
      } else if (m['t'] === 'term.snapshot' && resubscribed) {
        check(data.includes('smoke-42'), 'terminal snapshot from the screen worker');
        finish();
      } else if (m['t'] === 'term.snapshot' || m['t'] === 'term.data') {
        out += data;
        if (!resubscribed && out.includes('smoke-42')) {
          check(true, 'terminal output');
          resubscribed = true;
          send({ t: 'unsub', sessionId });
          send({ t: 'sub', sessionId });
        }
      }
    });
    ws.addEventListener('error', () => finish(new Error('websocket error')));
  });
}

try {
  const { port, pairCode } = await readyLine();
  check(true, `started on port ${port}`);
  const base = `http://127.0.0.1:${port}`;

  const page = await fetch(`${base}/`);
  const html = await page.text();
  check(page.status === 200 && html.includes('id="app"'), 'pairing page served from the embedded web app');
  const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  const js = asset === undefined ? undefined : await fetch(`${base}${asset}`);
  check(js?.status === 200, `asset ${asset ?? '(none found)'}`);

  const res = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairCode, deviceName: 'smoke' }),
  });
  const body: unknown = await res.json();
  const token = isRecord(body) && typeof body['token'] === 'string' ? body['token'] : undefined;
  check(res.status === 200 && token !== undefined, 'paired');
  if (token !== undefined) await terminalRoundTrip(port, token);
} finally {
  proc.kill('SIGINT');
  const code = await proc.exited;
  rmSync(dir, { recursive: true, force: true });
  check(code === 0, `clean shutdown (exit ${code})`);
}
