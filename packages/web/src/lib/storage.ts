import { effect, signal } from '@preact/signals';
import type { PairResponse } from '@phone-code/protocol';
import { isRecord, isString, isStringArray, parseJson } from './guards';

/** localStorage that never throws (private mode, quota, blocked storage), validated on read. */
export function load<T>(key: string, fallback: T, check: (v: unknown) => v is T): T {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return fallback;
  }
  if (raw === null) return fallback;
  const v = parseJson(raw);
  return check(v) ? v : fallback;
}

export function save(key: string, value: unknown): void {
  try {
    if (value === undefined || value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: keep working in memory.
  }
}

export interface Credentials extends PairResponse {
  pairedAt: number;
}

function isCreds(v: unknown): v is Credentials | null {
  return (
    v === null ||
    (isRecord(v) &&
      isString(v.token) &&
      isString(v.deviceId) &&
      typeof v.pairedAt === 'number' &&
      isRecord(v.host) &&
      isString(v.host.name))
  );
}

export const creds = signal<Credentials | null>(load<Credentials | null>('pc.creds', null, isCreds));
effect(() => save('pc.creds', creds.value));

export type ThemePref = 'system' | 'dark' | 'light';

export interface Settings {
  theme: ThemePref;
  termFontSize: number;
  notifications: boolean;
}

const defaults: Settings = { theme: 'system', termFontSize: 13, notifications: false };

function isPartialSettings(v: unknown): v is Partial<Settings> {
  if (!isRecord(v)) return false;
  const themeOk = v.theme === undefined || v.theme === 'system' || v.theme === 'dark' || v.theme === 'light';
  const sizeOk = v.termFontSize === undefined || typeof v.termFontSize === 'number';
  const notifOk = v.notifications === undefined || typeof v.notifications === 'boolean';
  return themeOk && sizeOk && notifOk;
}

export const settings = signal<Settings>({ ...defaults, ...load('pc.settings', {}, isPartialSettings) });
effect(() => save('pc.settings', settings.value));

export function updateSettings(patch: Partial<Settings>): void {
  settings.value = { ...settings.value, ...patch };
}

// ------------------------------------------------------------ drafts

export function loadDraft(sessionId: string): string {
  return load(`pc.draft.${sessionId}`, '', isString);
}

export function saveDraft(sessionId: string, text: string): void {
  save(`pc.draft.${sessionId}`, text || null);
}

// ------------------------------------------------------------ recent folders

export function recentDirs(): string[] {
  return load('pc.recentDirs', [], isStringArray);
}

export function pushRecentDir(path: string): void {
  save('pc.recentDirs', [path, ...recentDirs().filter((p) => p !== path)].slice(0, 6));
}

// ------------------------------------------------------------ per-harness defaults

/** What a new chat with a harness starts with: the choices made last time. */
export interface HarnessPrefs {
  model?: string;
  /** Thinking level; offered again only while the model in use accepts it. */
  effort?: string;
  mode?: string;
  cwd?: string;
}

function isPrefsMap(v: unknown): v is Record<string, HarnessPrefs> {
  return isRecord(v) && Object.values(v).every((p) => isRecord(p));
}

export const harnessPrefs = signal<Record<string, HarnessPrefs>>(load('pc.harness', {}, isPrefsMap));
effect(() => save('pc.harness', harnessPrefs.value));

export function setHarnessPrefs(harness: string, patch: HarnessPrefs): void {
  const cur = harnessPrefs.value[harness] ?? {};
  const next: HarnessPrefs = { ...cur, ...patch };
  if ('model' in patch && patch.model === undefined) delete next.model;
  if ('effort' in patch && patch.effort === undefined) delete next.effort;
  if ('mode' in patch && patch.mode === undefined) delete next.mode;
  if ('cwd' in patch && patch.cwd === undefined) delete next.cwd;
  harnessPrefs.value = { ...harnessPrefs.value, [harness]: next };
}

/** The harness the last new chat used (an agent id or `terminal`). */
export const lastHarness = signal<string | null>(
  load<string | null>('pc.lastHarness', null, (v): v is string | null => v === null || isString(v)),
);
effect(() => save('pc.lastHarness', lastHarness.value));

/** "Said once" notes (e.g. what plain http leaves out), so the app never nags. */
export function seen(key: string): boolean {
  return load(`pc.seen.${key}`, false, (v): v is boolean => typeof v === 'boolean');
}

export function markSeen(key: string): void {
  save(`pc.seen.${key}`, true);
}
