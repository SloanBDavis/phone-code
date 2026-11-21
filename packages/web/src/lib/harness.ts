import { batch, computed, signal } from '@preact/signals';
import type { AgentId, AgentInfo, Attachment, PermissionMode, SessionInfo } from '@phone-code/protocol';
import { toast } from '../ui/overlay';
import { CLASSIC_MODES, agentCatalog, modelOptions } from './agents';
import { client, uid } from './client';
import { openChat } from './nav';
import { host, type PendingSend, sessions } from './state';
import { harnessPrefs, lastHarness, pushRecentDir, setHarnessPrefs, settings } from './storage';
import { haptic } from './util';

/**
 * The harness pickers on the composer bar and the new chat they set up. A
 * harness is an agent the host runs (Claude Code, Codex, ACP agents) or the
 * terminal. What the user picks becomes that harness's default next time.
 */
export type Harness = AgentId | 'terminal';

/** Every harness the host reports, ready ones first (the terminal is always ready). */
export function harnessList(): Array<{ id: Harness; info?: AgentInfo; available: boolean }> {
  const agents = agentCatalog(host.value).map((a) => ({ id: a.id, info: a, available: a.available }));
  const all = [...agents, { id: 'terminal' as const, available: true }];
  return [...all.filter((x) => x.available), ...all.filter((x) => !x.available)];
}

export function agentInfo(id: Harness | undefined): AgentInfo | undefined {
  return id === undefined || id === 'terminal'
    ? undefined
    : agentCatalog(host.value).find((a) => a.id === id);
}

/** The harness picked in this new chat, before falling back to the last one used. */
const picked = signal<Harness | null>(null);

/** The harness a new chat uses: the one picked, else the last used, else the first ready agent. */
export const draftHarness = computed<Harness>(() => {
  const list = agentCatalog(host.value);
  const ready = (id: string | null): boolean => !!id && list.some((a) => a.id === id && a.available);
  const p = picked.value;
  if (p && p !== 'terminal') return p;
  const last = lastHarness.value;
  if (last && last !== 'terminal' && ready(last)) return last;
  return list.find((a) => a.available)?.id ?? list[0]?.id ?? 'claude';
});

export interface DraftChoices {
  harness: Harness;
  info?: AgentInfo;
  model?: string;
  mode: PermissionMode;
  modes: PermissionMode[];
  cwd: string;
}

export const draft = computed<DraftChoices>(() => {
  const harness = draftHarness.value;
  const info = agentInfo(harness);
  const prefs = harnessPrefs.value[harness] ?? {};
  const models = modelOptions(info);
  const model = prefs.model && models.some((m) => m.id === prefs.model) ? prefs.model : undefined;
  const modes = info?.permissionModes ?? CLASSIC_MODES;
  const mode = modes.find((m) => m === prefs.mode) ?? 'default';
  return { harness, info, model, mode, modes, cwd: prefs.cwd ?? host.value?.home ?? '~' };
});

export function pickHarness(id: Harness): void {
  batch(() => {
    picked.value = id;
    if (id !== 'terminal') lastHarness.value = id;
  });
}

export function pickModel(model: string | undefined): void {
  setHarnessPrefs(draftHarness.peek(), { model });
}

export function pickMode(mode: PermissionMode): void {
  setHarnessPrefs(draftHarness.peek(), { mode });
}

export function pickFolder(cwd: string, harness: Harness = draftHarness.peek()): void {
  setHarnessPrefs(harness, { cwd });
  pushRecentDir(cwd);
}

function termSize(): { cols: number; rows: number } {
  const fs = settings.value.termFontSize;
  const app = document.querySelector('.main') ?? document.querySelector('.app');
  const w = app?.clientWidth ?? innerWidth;
  const h = app?.clientHeight ?? innerHeight;
  return {
    cols: Math.max(40, Math.floor((w - 12) / (fs * 0.6))),
    rows: Math.max(12, Math.floor((h - 160) / (fs * 1.25))),
  };
}

function remember(s: SessionInfo): void {
  if (!sessions.peek().some((x) => x.id === s.id)) sessions.value = [s, ...sessions.peek()];
}

/** Choosing Terminal opens one right away, in the new chat's folder. */
export async function openTerminal(cwd = draft.peek().cwd): Promise<void> {
  haptic('medium');
  try {
    const s = await client.rpc({ t: 'session.create', params: { kind: 'terminal', cwd, ...termSize() } });
    pickFolder(cwd, 'terminal');
    remember(s);
    openChat(s.id);
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Could not open a terminal', 'warn');
  }
}

/** The first message of a new chat, shown while its session is being created. */
export const starting = signal<(PendingSend & { attachments: Attachment[] }) | null>(null);

/**
 * Send in a new chat: one gesture creates the session with the bar's choices
 * and sends the message. The bubble shows at once; when the session exists
 * the chat becomes that session, with the bubble carried over.
 */
export async function startChat(text: string, attachments: Attachment[] = []): Promise<void> {
  const d = draft.peek();
  if (d.harness === 'terminal') return;
  const pending = {
    localId: uid('local'),
    text,
    images: attachments.map((a) => `data:${a.mediaType};base64,${a.data}`),
    attachments,
    ts: Date.now(),
    status: 'sending' as const,
  };
  starting.value = pending;
  try {
    const s = await client.rpc({
      t: 'session.create',
      params: {
        kind: 'agent',
        agent: d.harness,
        cwd: d.cwd,
        ...(d.model ? { model: d.model } : {}),
        permissionMode: d.mode,
      },
    });
    pickFolder(d.cwd, d.harness);
    lastHarness.value = d.harness;
    batch(() => {
      remember(s);
      starting.value = null;
      picked.value = null;
      void client.sendChat(s.id, text, attachments);
      openChat(s.id);
    });
  } catch (e) {
    if (starting.peek()?.localId !== pending.localId) return;
    starting.value = { ...pending, status: 'failed' };
    toast(e instanceof Error ? e.message : 'Could not start the chat', 'warn');
  }
}

export function retryStart(): void {
  const s = starting.peek();
  if (s) void startChat(s.text, s.attachments);
}

/** Start a chat that continues a conversation found in "All chats". */
export async function resumeChat(params: {
  agent: AgentId;
  resumeId: string;
  cwd: string;
  title: string;
}): Promise<void> {
  try {
    const s = await client.rpc({ t: 'session.create', params: { kind: 'agent', ...params } });
    remember(s);
    openChat(s.id);
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Could not open that chat', 'warn');
  }
}
