import { signal, type Signal } from '@preact/signals';
import type { SlashCommand } from '@phone-code/protocol';
import { client } from './client';

/**
 * Slash commands a session accepts (`session.commands`), fetched when the
 * chat opens and again, at most every 30 s, when the palette opens. A daemon
 * without the call leaves the agent's built-in list (`AgentInfo.commands`).
 */
interface Entry {
  list: Signal<SlashCommand[] | null>;
  at: number;
}

const cache = new Map<string, Entry>();

export function sessionCommands(sessionId: string, refresh = false): Signal<SlashCommand[] | null> {
  let e = cache.get(sessionId);
  if (!e) {
    e = { list: signal(null), at: 0 };
    cache.set(sessionId, e);
  }
  const entry = e;
  if (entry.at === 0 || (refresh && Date.now() - entry.at > 30_000)) {
    entry.at = Date.now();
    client.rpc({ t: 'session.commands', sessionId }).then(
      (r) => {
        if (Array.isArray(r)) entry.list.value = r;
      },
      () => undefined,
    );
  }
  return entry.list;
}

const ORDER: Array<NonNullable<SlashCommand['source']> | 'other'> = [
  'project',
  'user',
  'plugin',
  'mcp',
  'builtin',
  'other',
];

export const SOURCE_LABEL: Record<(typeof ORDER)[number], string> = {
  project: 'This project',
  user: 'Yours',
  plugin: 'Plugins',
  mcp: 'MCP servers',
  builtin: 'Built in',
  other: 'Commands',
};

/** Commands matching what was typed after the slash, grouped by where they come from. */
export function groupCommands(
  list: SlashCommand[],
  typed: string,
): Array<{ source: (typeof ORDER)[number]; items: SlashCommand[] }> {
  const q = typed.toLowerCase();
  const hits = list
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .toSorted((a, b) => {
      // Prefix matches first, then alphabetical.
      const pa = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const pb = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return pa - pb || a.name.localeCompare(b.name);
    });
  return ORDER.map((source) => ({
    source,
    items: hits.filter((c) => (c.source ?? 'other') === source),
  })).filter((g) => g.items.length > 0);
}
