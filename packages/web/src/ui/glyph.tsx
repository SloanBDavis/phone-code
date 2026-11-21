import type { JSX } from 'preact';
import type { AgentKind, SessionInfo } from '@phone-code/protocol';

export type GlyphKind = AgentKind | 'terminal';

export const glyphOf = (s: Pick<SessionInfo, 'kind' | 'agent'>): GlyphKind =>
  s.kind === 'terminal' ? 'terminal' : (s.agent ?? 'claude');

export const agentName = (k: GlyphKind): string =>
  k === 'claude' ? 'Claude Code' : k === 'codex' ? 'Codex' : 'Terminal';

/**
 * Original marks (not vendor logos): a soft asterisk for Claude Code, code
 * brackets for Codex, a prompt for the terminal. Each sits on a tinted tile
 * whose corner radius is concentric with the row it lives in.
 */
export function Glyph({ kind, size = 40 }: { kind: GlyphKind; size?: number }): JSX.Element {
  return (
    <span class={`glyph glyph-${kind}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size * 0.56} height={size * 0.56} viewBox="0 0 24 24" fill="none">
        {kind === 'claude' && (
          <g stroke="currentColor" stroke-width="2.6" stroke-linecap="round">
            <path d="M12 4v16" />
            <path d="M5.07 8l13.86 8" />
            <path d="M5.07 16l13.86-8" />
          </g>
        )}
        {kind === 'codex' && (
          <g stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 6.5L3.5 12 8 17.5" />
            <path d="M16 6.5l4.5 5.5-4.5 5.5" />
            <path d="M13.5 5l-3 14" />
          </g>
        )}
        {kind === 'terminal' && (
          <g stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4.5 7l5 5-5 5" />
            <path d="M12.5 17.5h7" />
          </g>
        )}
      </svg>
    </span>
  );
}
