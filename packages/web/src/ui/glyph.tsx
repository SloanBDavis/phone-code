import type { JSX } from 'preact';
import { DEFAULT_AGENT, type SessionInfo } from '@phone-code/protocol';
import { findAgent } from '../lib/agents';
import { host } from '../lib/state';

/**
 * What a glyph shows: an agent id (`claude`, `codex`, `gemini`, …), the
 * terminal, or the app's own mark.
 */
export type GlyphKind = string;

/** Glyph for an agent id (a session without one is Claude Code). */
export const agentGlyph = (agent: string | undefined): GlyphKind => agent ?? DEFAULT_AGENT;

export const glyphOf = (s: Pick<SessionInfo, 'kind' | 'agent'>): GlyphKind =>
  s.kind === 'terminal' ? 'terminal' : agentGlyph(s.agent);

/** For daemons that send no `monogram`, and Cursor's app (not in the catalog). */
const MONOGRAMS: Record<string, string> = {
  claude: 'CC',
  codex: 'Cx',
  gemini: 'Ge',
  opencode: 'Oc',
  copilot: 'Co',
  cursor: 'Cu',
  'cursor-app': 'Cu',
};

/** Two letters for an agent: its own ("CC", "Cx"), or the id's first two, capitalized. */
function monogram(id: string): string {
  const known = findAgent(host.value, id)?.monogram ?? MONOGRAMS[id];
  if (known) return known;
  const two = id.replace(/[^a-z0-9]/gi, '').slice(0, 2) || '?';
  return two.charAt(0).toUpperCase() + two.slice(1).toLowerCase();
}

/**
 * Graphite marks: no look-alike vendor logos and no per-agent colors. An
 * agent is a monogram on a quiet gray tile; the terminal (and the app itself)
 * is the app icon at any size: a white prompt on a near-black tile, in both
 * light and dark mode. Corners are ~0.3 of
 * the size, like the native app's.
 */
export function Glyph({ kind, size = 40 }: { kind: GlyphKind; size?: number }): JSX.Element {
  const mark = kind === 'terminal' || kind === 'app';
  return (
    <span
      class={`glyph ${mark ? 'glyph-mark' : 'glyph-agent'}`}
      data-glyph={kind}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: `${Math.round(size * 0.3)}px`,
        fontSize: `${(size * (mark ? 0.4 : 0.38)).toFixed(1)}px`,
      }}
      aria-hidden="true"
    >
      {mark ? '>_' : monogram(kind)}
    </span>
  );
}
