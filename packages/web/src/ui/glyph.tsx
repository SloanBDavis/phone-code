import type { JSX } from 'preact';
import type { AgentKind, SessionInfo } from '@phone-code/protocol';

/** `acp`: any agent driven through the Agent Client Protocol (Gemini CLI, OpenCode, …). */
export type GlyphKind = AgentKind | 'antigravity' | 'acp' | 'terminal';

/** Glyph for an agent id: the native marks for Claude Code and Codex, Antigravity's own, the generic ACP mark otherwise. */
export const agentGlyph = (agent: string | undefined): GlyphKind =>
  agent === undefined || agent === 'claude'
    ? 'claude'
    : agent === 'codex'
      ? 'codex'
      : agent === 'antigravity'
        ? 'antigravity'
        : 'acp';

export const glyphOf = (s: Pick<SessionInfo, 'kind' | 'agent'>): GlyphKind =>
  s.kind === 'terminal' ? 'terminal' : agentGlyph(s.agent);

export const agentName = (k: GlyphKind): string =>
  k === 'claude'
    ? 'Claude Code'
    : k === 'codex'
      ? 'Codex'
      : k === 'antigravity'
        ? 'Antigravity'
        : k === 'acp'
          ? 'Agent'
          : 'Terminal';

/**
 * Original marks (not vendor logos): a soft asterisk for Claude Code, code
 * brackets for Codex, a ball lifting off the ground for Antigravity, a
 * hexagon node for any other ACP agent, a prompt for the
 * terminal. Each sits on a tinted tile whose corner radius is concentric with
 * the row it lives in.
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
        {kind === 'acp' && (
          <g stroke="currentColor" stroke-width="2.3" stroke-linejoin="round">
            <path d="M12 3.6l7.3 4.2v8.4L12 20.4l-7.3-4.2V7.8z" />
            <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
          </g>
        )}
        {kind === 'antigravity' && (
          <g stroke="currentColor" stroke-width="2.3" stroke-linecap="round">
            <circle cx="12" cy="8.2" r="3.6" fill="currentColor" stroke="none" />
            <path d="M8.6 15.6v-1.8" />
            <path d="M12 16.6v-2.8" />
            <path d="M15.4 15.6v-1.8" />
            <path d="M5 20h14" />
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
