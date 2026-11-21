import { effect, signal } from '@preact/signals';
import type { PairResponse } from '@phone-code/protocol';

/** localStorage that never throws (private mode, quota, blocked storage). */
export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
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

export const creds = signal<Credentials | null>(load<Credentials | null>('pc.creds', null));
effect(() => save('pc.creds', creds.value));

export type ThemePref = 'system' | 'dark' | 'light';

export interface Settings {
  theme: ThemePref;
  termFontSize: number;
  notifications: boolean;
}

const defaults: Settings = { theme: 'system', termFontSize: 13, notifications: false };

export const settings = signal<Settings>({ ...defaults, ...load<Partial<Settings>>('pc.settings', {}) });
effect(() => save('pc.settings', settings.value));

export function updateSettings(patch: Partial<Settings>): void {
  settings.value = { ...settings.value, ...patch };
}

// ------------------------------------------------------------ drafts

export function loadDraft(sessionId: string): string {
  return load<string>(`pc.draft.${sessionId}`, '');
}

export function saveDraft(sessionId: string, text: string): void {
  save(`pc.draft.${sessionId}`, text || null);
}

// ------------------------------------------------------------ recent folders

export function recentDirs(): string[] {
  return load<string[]>('pc.recentDirs', []);
}

export function pushRecentDir(path: string): void {
  save('pc.recentDirs', [path, ...recentDirs().filter((p) => p !== path)].slice(0, 6));
}
