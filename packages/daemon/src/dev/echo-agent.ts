/**
 * A fake agent for developing the daemon and the web app without Claude Code
 * or Codex installed. Enabled with PHONECODE_ECHO_AGENT=1.
 *
 * It streams back what you send. Magic words in the message:
 *   "perm"  asks for permission before a fake Bash tool call
 *   "ask"   asks a multiple-choice question
 *   "slow"  streams slowly (try interrupting)
 */
import type { AgentKind, PermissionDecision, PermissionMode } from '@phone-code/protocol';
import type { AdapterRegistry, AgentAdapter, AgentEvents, AgentSession } from '../agents/types.ts';
import { randomId } from '../util/files.ts';

/** Feed `parts` to `emit` one per `delayMs`, stopping early when `stopped()`. */
function drip(
  parts: string[],
  delayMs: number,
  emit: (part: string) => void,
  stopped: () => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    let i = 0;
    const next = (): void => {
      const part = parts[i];
      if (part === undefined || stopped()) {
        resolve();
        return;
      }
      i += 1;
      emit(part);
      setTimeout(next, delayMs);
    };
    next();
  });
}

class EchoSession implements AgentSession {
  private interrupted = false;
  private waiters = new Map<string, (answer: string) => void>();

  constructor(private readonly events: AgentEvents) {}

  private wait(itemId: string): Promise<string> {
    return new Promise((resolve) => this.waiters.set(itemId, resolve));
  }

  async send(text: string): Promise<void> {
    const started = Date.now();
    this.interrupted = false;
    this.events.status('running');
    const lower = text.toLowerCase();
    if (lower.includes('perm')) {
      const permId = `p_${randomId()}`;
      const command = 'echo hello from the echo agent';
      const detail = { type: 'command' as const, command };
      this.events.upsert({
        id: permId,
        ts: Date.now(),
        kind: 'permission',
        toolName: 'Bash',
        title: command,
        input: { command },
        detail,
        status: 'pending',
        canAllowAlways: true,
      });
      this.events.status('waiting');
      const decision = await this.wait(permId);
      const allowed = decision !== 'deny';
      this.events.upsert({
        id: permId,
        ts: Date.now(),
        kind: 'permission',
        toolName: 'Bash',
        title: command,
        detail,
        status: allowed ? 'allowed' : 'denied',
      });
      this.events.status('running');
      this.events.upsert({
        id: `t_${randomId()}`,
        ts: Date.now(),
        kind: 'tool',
        name: 'Bash',
        title: command,
        status: allowed ? 'done' : 'denied',
        detail: { ...detail, exitCode: 0 },
        ...(allowed ? { output: 'hello from the echo agent\n' } : {}),
      });
    }
    if (lower.includes('ask')) {
      const qId = `q_${randomId()}`;
      const question = 'Which flavour?';
      const base = {
        id: qId,
        ts: Date.now(),
        kind: 'question' as const,
        questions: [
          { question, options: [{ label: 'Vanilla' }, { label: 'Chocolate', description: 'Dark' }] },
        ],
      };
      this.events.upsert({ ...base, status: 'pending' });
      this.events.status('waiting');
      const answer = await this.wait(qId);
      this.events.upsert({ ...base, status: 'answered', answers: { [question]: answer } });
      this.events.status('running');
    }
    const replyId = `a_${randomId()}`;
    this.events.upsert({ id: replyId, ts: Date.now(), kind: 'text', text: '', streaming: true });
    await drip(
      `You said: ${text}`.split(/(\s+)/),
      lower.includes('slow') ? 150 : 5,
      (w) => this.events.delta(replyId, w),
      () => this.isInterrupted(),
    );
    this.events.upsert({
      id: replyId,
      ts: Date.now(),
      kind: 'text',
      text: `You said: ${text}`,
      streaming: false,
    });
    this.events.upsert({
      id: `turn_${randomId()}`,
      ts: Date.now(),
      kind: 'turn',
      outcome: this.isInterrupted() ? 'interrupted' : 'completed',
      durationMs: Date.now() - started,
    });
    this.events.status('idle');
  }

  private isInterrupted(): boolean {
    return this.interrupted;
  }

  interrupt(): Promise<void> {
    this.interrupted = true;
    for (const resolve of this.waiters.values()) resolve('deny');
    this.waiters.clear();
    return Promise.resolve();
  }

  resolvePermission(itemId: string, decision: PermissionDecision): void {
    this.waiters.get(itemId)?.(decision);
    this.waiters.delete(itemId);
  }

  answerQuestion(itemId: string, answers: Record<string, string>): void {
    this.waiters.get(itemId)?.(Object.values(answers).join(', '));
    this.waiters.delete(itemId);
  }

  setPermissionMode(mode: PermissionMode): Promise<void> {
    this.events.meta({ permissionMode: mode });
    return Promise.resolve();
  }

  setModel(model: string): Promise<void> {
    this.events.meta({ model });
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    return this.interrupt();
  }
}

function echoAdapter(kind: AgentKind, name: string): AgentAdapter {
  return {
    kind,
    name,
    detect: () => Promise.resolve({ available: true, version: 'echo', models: ['echo-small', 'echo-large'] }),
    start(opts, events) {
      events.nativeSessionId(opts.resumeId ?? `echo-${randomId()}`);
      events.meta({ model: opts.model ?? 'echo-small', permissionMode: opts.permissionMode ?? 'default' });
      if (opts.resumeId !== undefined) {
        // Like a real adapter, replay history on resume (the core drops it if it already has it).
        events.upsert({
          id: `hist_${opts.resumeId}`,
          ts: Date.now(),
          kind: 'text',
          text: '(resumed)',
          streaming: false,
        });
      }
      return Promise.resolve(new EchoSession(events));
    },
    listResumable: () => Promise.resolve([]),
  };
}

export function createEchoAdapters(): AdapterRegistry {
  return { claude: echoAdapter('claude', 'Claude Code'), codex: echoAdapter('codex', 'Codex') };
}
