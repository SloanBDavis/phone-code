import {
  PROTOCOL_VERSION,
  type ChatItem,
  type ClientMessage,
  type ServerMessage,
  type SessionInfo,
  type TextItem,
  type ThinkingItem,
  type ToolItem,
} from '@phone-code/protocol';
import type { Transport, TransportEvents } from '../transport';
import { buildDemo, demoHost, fsList, history, HOME, longSession } from './data';
import { DemoShell } from './shell';

interface Sim {
  info: SessionInfo;
  items: ChatItem[];
  seq: number;
  subscribed: boolean;
  shell?: DemoShell;
  /** Cancels whatever scripted activity is in flight. */
  abort?: () => void;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });

const REPLIES = [
  {
    thinking:
      'The user wants a concise answer. I can check the relevant file quickly and then explain what to change.',
    command: 'git diff --stat HEAD~1',
    output:
      ' src/auth/session.ts      | \x1b[32m6 ++++\x1b[31m--\x1b[0m\n test/auth/refresh.test.ts | \x1b[32m3 +++\x1b[0m\n 2 files changed, \x1b[32m7 insertions(+)\x1b[0m, \x1b[31m2 deletions(-)\x1b[0m',
    text: "Done. Here's what changed:\n\n- `session.ts` now tolerates **30s of clock skew**.\n- The test fixture uses an explicit `ttlMs` instead of `0`.\n\n```ts\nconst skewMs = 30_000;\nif (session.expiresAt + skewMs < Date.now()) {\n  throw new SessionExpired(session.id);\n}\n```\n\nWant me to open a pull request?",
  },
  {
    thinking: 'Short follow-up. Let me look at the test runner config before answering.',
    command: 'cat vitest.config.ts | head -20',
    output: "export default defineConfig({\n  test: { pool: 'threads', retry: 0, testTimeout: 5_000 },\n});",
    text: 'The suite runs with `retry: 0`, which is right: retries would hide flakiness like this one. I left it as is.\n\n| Setting | Value | Why |\n| --- | --- | --- |\n| `pool` | threads | fastest on CI |\n| `retry` | 0 | surface flaky tests |\n| `testTimeout` | 5s | default is fine |',
  },
];

/** A whole host simulated in the browser: sessions, scripted agents, a fake shell. */
export class DemoTransport implements Transport {
  readonly demo = true;
  private events: TransportEvents | null = null;
  private sims = new Map<string, Sim>();
  private order: string[] = [];
  private replyN = 0;
  private live = false;

  start(events: TransportEvents): void {
    this.events = events;
    this.live = true;
    const long = Number(new URLSearchParams(location.search).get('demoItems') ?? 0);
    const all = long > 0 ? [...buildDemo(), longSession(Math.min(long, 20_000))] : buildDemo();
    for (const d of all) {
      this.sims.set(d.info.id, { info: d.info, items: d.items, seq: d.items.length, subscribed: false });
      this.order.push(d.info.id);
    }
    events.status('connecting');
    setTimeout(() => {
      if (!this.live) return;
      events.status('open');
      this.emit({ t: 'ready', v: PROTOCOL_VERSION, host: demoHost, deviceId: 'demo-device' });
      this.pushSessions();
      this.runBilling();
    }, 250);
  }

  stop(): void {
    this.live = false;
    for (const s of this.sims.values()) {
      s.abort?.();
      s.shell?.dispose();
    }
  }

  retryNow(): void {
    // Always connected.
  }

  send(msg: ClientMessage): boolean {
    if (!this.live) return false;
    // Answer asynchronously like a real network would.
    queueMicrotask(() => this.handle(msg));
    return true;
  }

  // ---------------------------------------------------------------- plumbing

  private emit(m: ServerMessage): void {
    // Clone like a real network hop, so the client never shares objects with the simulator.
    if (this.live) this.events?.message(structuredClone(m));
  }

  private ok(id: string, data?: unknown): void {
    setTimeout(() => this.emit({ t: 'res', id, ok: true, data }), 60 + Math.random() * 120);
  }

  private fail(id: string, error: string): void {
    this.emit({ t: 'res', id, ok: false, error });
  }

  private pushSessions(): void {
    const list = this.order
      .map((id) => this.sims.get(id)?.info)
      .filter((s): s is SessionInfo => !!s)
      .toSorted((a, b) => b.updatedAt - a.updatedAt);
    this.emit({ t: 'sessions', sessions: list });
  }

  private touch(sim: Sim, patch: Partial<SessionInfo>): void {
    sim.info = { ...sim.info, updatedAt: Date.now(), ...patch };
    if (sim.subscribed) sim.info.unread = false;
    this.pushSessions();
  }

  private put(sim: Sim, item: ChatItem): void {
    const i = sim.items.findIndex((x) => x.id === item.id);
    if (i >= 0) sim.items[i] = item;
    else sim.items.push(item);
    sim.seq++;
    if (sim.subscribed) this.emit({ t: 'chat.item', sessionId: sim.info.id, seq: sim.seq, item });
  }

  private delta(sim: Sim, itemId: string, text: string): void {
    const item = sim.items.find((x) => x.id === itemId);
    if (item && (item.kind === 'text' || item.kind === 'thinking')) item.text += text;
    sim.seq++;
    if (sim.subscribed) this.emit({ t: 'chat.delta', sessionId: sim.info.id, seq: sim.seq, itemId, text });
  }

  private async stream(
    sim: Sim,
    item: TextItem | ThinkingItem,
    text: string,
    sig: AbortSignal,
  ): Promise<void> {
    this.put(sim, { ...item, text: '', streaming: true });
    const chunks: string[] = [];
    for (let i = 0; i < text.length;) {
      const n = 2 + Math.floor(Math.random() * 6);
      chunks.push(text.slice(i, i + n));
      i += n;
    }
    // Chunks must arrive in order with a pause between them, like a real stream.
    await chunks.reduce<Promise<void>>(
      (prev, chunk) =>
        prev.then(() => {
          this.delta(sim, item.id, chunk);
          return sleep(18 + Math.random() * 30, sig);
        }),
      Promise.resolve(),
    );
    const final = sim.items.find((x) => x.id === item.id);
    if (final && (final.kind === 'text' || final.kind === 'thinking'))
      this.put(sim, { ...final, streaming: false });
    if (item.kind === 'text')
      this.touch(sim, { preview: text.split('\n')[0]?.replace(/[*`#]/g, '').slice(0, 90) });
  }

  private nid(p: string): string {
    return `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  /** Runs a scripted activity that can be interrupted. */
  private activity(sim: Sim, fn: (sig: AbortSignal) => Promise<void>): void {
    sim.abort?.();
    const ctrl = new AbortController();
    sim.abort = () => ctrl.abort();
    const started = Date.now();
    this.touch(sim, { status: 'running' });
    const run = async (): Promise<void> => {
      try {
        await fn(ctrl.signal);
      } catch {
        this.interrupted(sim, started);
        return;
      } finally {
        if (sim.abort) sim.abort = undefined;
      }
      this.put(sim, {
        id: this.nid('turn'),
        ts: Date.now(),
        kind: 'turn',
        outcome: 'completed',
        durationMs: Date.now() - started,
        costUsd: Math.round(Math.random() * 8 + 2) / 100,
      });
      this.touch(sim, { status: 'idle' });
    };
    void run();
  }

  private interrupted(sim: Sim, started: number): void {
    for (const it of sim.items)
      if ((it.kind === 'text' || it.kind === 'thinking') && it.streaming)
        this.put(sim, { ...it, streaming: false });
      else if (it.kind === 'tool' && it.status === 'running') this.put(sim, { ...it, status: 'error' });
    this.put(sim, {
      id: this.nid('turn'),
      ts: Date.now(),
      kind: 'turn',
      outcome: 'interrupted',
      durationMs: Date.now() - started,
    });
    this.touch(sim, { status: 'idle' });
  }

  private async tool(sim: Sim, tool: ToolItem, ms: number, sig: AbortSignal): Promise<void> {
    this.put(sim, { ...tool, status: 'running', output: undefined });
    this.touch(sim, { preview: `${tool.name === 'Bash' ? 'Running' : tool.name} ${tool.title}` });
    await sleep(ms, sig);
    this.put(sim, tool);
  }

  // ---------------------------------------------------------------- scripts

  private reply(sim: Sim): void {
    const r = REPLIES[this.replyN++ % REPLIES.length];
    if (!r) return;
    this.activity(sim, async (sig) => {
      await sleep(500, sig);
      await this.stream(
        sim,
        { id: this.nid('th'), ts: Date.now(), kind: 'thinking', text: '', streaming: true },
        r.thinking,
        sig,
      );
      await this.tool(
        sim,
        {
          id: this.nid('tool'),
          ts: Date.now(),
          kind: 'tool',
          name: 'Bash',
          title: r.command,
          status: 'done',
          detail: { type: 'command', command: r.command, exitCode: 0 },
          output: r.output,
        },
        900,
        sig,
      );
      await this.stream(
        sim,
        { id: this.nid('t'), ts: Date.now(), kind: 'text', text: '', streaming: true },
        r.text,
        sig,
      );
    });
  }

  private afterPermission(sim: Sim, allowed: boolean, message?: string): void {
    this.activity(sim, async (sig) => {
      if (!allowed) {
        await sleep(400, sig);
        await this.stream(
          sim,
          { id: this.nid('t'), ts: Date.now(), kind: 'text', text: '', streaming: true },
          message
            ? `Understood: "${message}". I won't run the suite. The fix is in place in \`src/auth/session.ts\`; you can run the tests yourself whenever you like.`
            : "Okay, I won't run it. The fix is in place in `src/auth/session.ts`; you can run the tests yourself whenever you like.",
          sig,
        );
        return;
      }
      const lines = Array.from(
        { length: 20 },
        (_, i) =>
          `\x1b[32m✓\x1b[0m auth/refresh.test.ts \x1b[2m(run ${i + 1}/20)\x1b[22m \x1b[2m${180 + ((i * 37) % 90)}ms\x1b[0m`,
      );
      await this.tool(
        sim,
        {
          id: this.nid('tool'),
          ts: Date.now(),
          kind: 'tool',
          name: 'Bash',
          title: 'npm test -- --repeat 20 auth',
          status: 'done',
          detail: { type: 'command', command: 'npm test -- --repeat 20 auth', exitCode: 0 },
          output: `${lines.join('\n')}\n\n \x1b[1mTests\x1b[22m  \x1b[1m\x1b[32m20 passed\x1b[0m (20)\n \x1b[1mTime\x1b[22m   4.12s`,
        },
        1600,
        sig,
      );
      await this.stream(
        sim,
        { id: this.nid('t'), ts: Date.now(), kind: 'text', text: '', streaming: true },
        '**20 out of 20 runs pass.** The flake came from the strict `expiresAt < Date.now()` comparison; with the skew allowance the boundary case no longer depends on how fast the runner is.\n\nI also tightened the fixture so it states its TTL explicitly.',
        sig,
      );
    });
  }

  private afterAnswer(sim: Sim, answer: string): void {
    this.activity(sim, async (sig) => {
      await sleep(400, sig);
      await this.stream(
        sim,
        { id: this.nid('t'), ts: Date.now(), kind: 'text', text: '', streaming: true },
        `Going with **${answer}**. I'll add it and build a \`RevenueChart\` component that reads from the existing \`/api/revenue\` endpoint.`,
        sig,
      );
      await this.tool(
        sim,
        {
          id: this.nid('tool'),
          ts: Date.now(),
          kind: 'tool',
          name: 'Bash',
          title: `npm install ${answer.toLowerCase().includes('svg') ? '--save-dev @types/d3-shape' : answer.toLowerCase()}`,
          status: 'done',
          detail: { type: 'command', command: `npm install ${answer.toLowerCase()}`, exitCode: 0 },
          output: '\nadded 1 package in 1s',
        },
        1200,
        sig,
      );
      await this.tool(
        sim,
        {
          id: this.nid('tool'),
          ts: Date.now(),
          kind: 'tool',
          name: 'Write',
          title: 'src/components/RevenueChart.tsx',
          status: 'done',
          detail: {
            type: 'diff',
            path: 'src/components/RevenueChart.tsx',
            added: 6,
            removed: 0,
            patch:
              "@@ -0,0 +1,6 @@\n+import { useRevenue } from '../api';\n+\n+export function RevenueChart() {\n+  const data = useRevenue('90d');\n+  return <Chart data={data} height={220} />;\n+}",
          },
        },
        900,
        sig,
      );
      await this.stream(
        sim,
        { id: this.nid('t'), ts: Date.now(), kind: 'text', text: '', streaming: true },
        'The chart is on the home page above the activity feed. It shows the last 90 days and follows the dashboard theme.',
        sig,
      );
    });
  }

  /** The Codex session keeps working in the background so "Running" is real. */
  private runBilling(): void {
    const sim = this.sims.get('demo-billing');
    if (!sim) return;
    const ctrl = new AbortController();
    sim.abort = () => ctrl.abort();
    const sig = ctrl.signal;
    const script = async (): Promise<void> => {
      await sleep(2500, sig);
      await this.tool(
        sim,
        {
          id: this.nid('tool'),
          ts: Date.now(),
          kind: 'tool',
          name: 'Write',
          title: 'src/billing/render.ts',
          status: 'done',
          detail: {
            type: 'diff',
            path: 'src/billing/render.ts',
            added: 5,
            removed: 0,
            patch:
              "@@ -0,0 +1,5 @@\n+import type { Invoice } from './types';\n+import { pdf } from '../lib/pdf';\n+\n+export const renderPdf = (inv: Invoice) =>\n+  pdf.render('invoice', inv, { locale: inv.locale });",
          },
        },
        1400,
        sig,
      );
      const todo = sim.items.find((x) => x.id === 'todo-billing');
      if (todo?.kind === 'tool' && todo.detail?.type === 'todos') {
        this.put(sim, {
          ...todo,
          detail: {
            type: 'todos',
            todos: todo.detail.todos.map((t, i) =>
              Object.assign({}, t, {
                status: i < 3 ? 'completed' : i === 3 ? 'in_progress' : 'pending',
              } as const),
            ),
          },
        });
      }
      await this.tool(
        sim,
        {
          id: this.nid('tool'),
          ts: Date.now(),
          kind: 'tool',
          name: 'Bash',
          title: 'npx tsc --noEmit -p .',
          status: 'done',
          detail: { type: 'command', command: 'npx tsc --noEmit -p .', exitCode: 0 },
          output: '',
        },
        2600,
        sig,
      );
      await this.stream(
        sim,
        { id: this.nid('t'), ts: Date.now(), kind: 'text', text: '', streaming: true },
        'Typecheck is clean. Wiring up the re-exports in `billing/index.ts` now.',
        sig,
      );
      await sleep(20_000, sig);
    };
    const started = Date.now();
    const run = async (): Promise<void> => {
      try {
        await script();
      } catch {
        return; // interrupted by the user
      }
      if (sim.abort) sim.abort = undefined;
      this.put(sim, {
        id: this.nid('turn'),
        ts: Date.now(),
        kind: 'turn',
        outcome: 'completed',
        durationMs: Date.now() - started + 14 * 60_000,
        costUsd: 0.37,
      });
      this.touch(sim, { status: 'idle', preview: 'Billing module split into tax.ts and render.ts.' });
    };
    void run();
  }

  // ---------------------------------------------------------------- handlers

  private handle(msg: ClientMessage): void {
    switch (msg.t) {
      case 'hello':
      case 'ping':
        return;
      case 'session.create': {
        const p = msg.params;
        const id = this.nid('s');
        const cwd = (p.cwd ?? HOME).replace(/^~/, HOME);
        const title =
          p.title ??
          (p.kind === 'terminal'
            ? 'zsh'
            : p.resumeId
              ? (history().find((h) => h.resumeId === p.resumeId)?.title ?? 'Resumed session')
              : 'New session');
        const info: SessionInfo = {
          id,
          kind: p.kind,
          ...(p.agent ? { agent: p.agent } : {}),
          title,
          cwd,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: 'idle',
          ...(p.kind === 'agent'
            ? {
                model: p.model ?? demoHost.agents.find((a) => a.kind === p.agent)?.models?.[0],
                permissionMode: p.permissionMode ?? 'default',
              }
            : {}),
        };
        const items: ChatItem[] = p.resumeId
          ? [
              {
                id: this.nid('n'),
                ts: Date.now(),
                kind: 'notice',
                level: 'info',
                text: 'Resumed from your computer. Earlier messages are summarized by the agent.',
              },
            ]
          : [];
        this.sims.set(id, { info, items, seq: items.length, subscribed: false });
        this.order.unshift(id);
        this.pushSessions();
        this.ok(msg.id, info);
        return;
      }
      case 'session.rename': {
        const sim = this.sims.get(msg.sessionId);
        if (!sim) return this.fail(msg.id, 'Session not found');
        sim.info = { ...sim.info, title: msg.title };
        this.pushSessions();
        this.ok(msg.id, sim.info);
        return;
      }
      case 'session.delete': {
        const sim = this.sims.get(msg.sessionId);
        sim?.abort?.();
        sim?.shell?.dispose();
        this.sims.delete(msg.sessionId);
        this.order = this.order.filter((x) => x !== msg.sessionId);
        this.pushSessions();
        this.ok(msg.id);
        return;
      }
      case 'fs.list':
        this.ok(msg.id, fsList(msg.path));
        return;
      case 'history.list':
        this.ok(
          msg.id,
          history().filter((h) => !msg.agent || h.agent === msg.agent),
        );
        return;
      case 'sub': {
        const sim = this.sims.get(msg.sessionId);
        if (!sim) {
          this.emit({ t: 'error', code: 'not_found', message: 'No such session' });
          return;
        }
        sim.subscribed = true;
        if (sim.info.unread) this.touch(sim, { unread: false, updatedAt: sim.info.updatedAt });
        if (sim.info.kind === 'terminal') {
          sim.shell ??= new DemoShell(
            sim.info.cwd,
            (data) => {
              sim.seq++;
              if (sim.subscribed) this.emit({ t: 'term.data', sessionId: sim.info.id, seq: sim.seq, data });
            },
            sim.info.status === 'exited',
          );
          setTimeout(() => {
            this.emit({
              t: 'term.snapshot',
              sessionId: sim.info.id,
              seq: sim.seq,
              cols: 80,
              rows: 24,
              data: sim.shell?.snapshot() ?? '',
            });
            if (sim.info.status === 'exited')
              this.emit({ t: 'term.exit', sessionId: sim.info.id, exitCode: 0 });
          }, 80);
          return;
        }
        setTimeout(
          () => this.emit({ t: 'chat.snapshot', sessionId: sim.info.id, seq: sim.seq, items: sim.items }),
          90,
        );
        return;
      }
      case 'unsub': {
        const sim = this.sims.get(msg.sessionId);
        if (sim) sim.subscribed = false;
        return;
      }
      case 'chat.send': {
        const sim = this.sims.get(msg.sessionId);
        if (!sim) return this.fail(msg.id, 'Session not found');
        const itemId = this.nid('u');
        this.put(sim, {
          id: itemId,
          ts: Date.now(),
          kind: 'user',
          text: msg.text,
          ...(msg.attachments?.length
            ? {
                attachments: msg.attachments.map((a) => ({
                  mediaType: a.mediaType,
                  name: a.name,
                  data: a.data,
                })),
              }
            : {}),
        });
        this.touch(sim, { preview: msg.text.slice(0, 90) });
        if (sim.info.title === 'New session') this.touch(sim, { title: msg.text.slice(0, 40) });
        this.ok(msg.id, { itemId });
        this.reply(sim);
        return;
      }
      case 'chat.interrupt': {
        const sim = this.sims.get(msg.sessionId);
        sim?.abort?.();
        return;
      }
      case 'chat.permission': {
        const sim = this.sims.get(msg.sessionId);
        const item = sim?.items.find((x) => x.id === msg.itemId);
        if (!sim || item?.kind !== 'permission') return;
        const allowed = msg.decision !== 'deny';
        this.put(sim, { ...item, status: allowed ? 'allowed' : 'denied' });
        this.afterPermission(sim, allowed, msg.message);
        return;
      }
      case 'chat.answer': {
        const sim = this.sims.get(msg.sessionId);
        const item = sim?.items.find((x) => x.id === msg.itemId);
        if (!sim || item?.kind !== 'question') return;
        this.put(sim, { ...item, status: 'answered', answers: msg.answers });
        this.afterAnswer(sim, Object.values(msg.answers)[0] ?? 'that');
        return;
      }
      case 'chat.setMode': {
        const sim = this.sims.get(msg.sessionId);
        if (sim) this.touch(sim, { permissionMode: msg.permissionMode, updatedAt: sim.info.updatedAt });
        return;
      }
      case 'chat.setModel': {
        const sim = this.sims.get(msg.sessionId);
        if (sim) this.touch(sim, { model: msg.model, updatedAt: sim.info.updatedAt });
        return;
      }
      case 'term.input': {
        this.sims.get(msg.sessionId)?.shell?.input(msg.data);
        return;
      }
      case 'term.resize':
        return;
      case 'push.subscribe':
      case 'push.unsubscribe':
        this.ok(msg.id);
        return;
      default: {
        const never: never = msg;
        return never;
      }
    }
  }
}
