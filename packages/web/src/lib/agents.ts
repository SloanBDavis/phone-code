import type { AgentId, AgentInfo, HostInfo, SessionInfo } from '@phone-code/protocol';

const NATIVE_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
const SHORT_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

/**
 * Every agent the host offers. Daemons before the multi-agent protocol only
 * send `agents` (Claude Code and Codex), so fall back to that.
 */
export function agentCatalog(h: HostInfo | null | undefined): AgentInfo[] {
  if (!h) return [];
  if (h.agentCatalog) return h.agentCatalog;
  return h.agents.map((a) => ({
    id: a.kind,
    name: NATIVE_NAMES[a.kind] ?? a.kind,
    impl: 'native' as const,
    available: a.available,
    ...(a.version === undefined ? {} : { version: a.version }),
    ...(a.models === undefined ? {} : { models: a.models }),
  }));
}

export function findAgent(h: HostInfo | null | undefined, id: AgentId | undefined): AgentInfo | undefined {
  return id === undefined ? undefined : agentCatalog(h).find((a) => a.id === id);
}

/** Display name of a session's agent: "Claude Code", "Codex", "Gemini CLI"… */
export function agentLabel(s: Pick<SessionInfo, 'agent' | 'agentName'>, h?: HostInfo | null): string {
  const id = s.agent ?? 'claude';
  return s.agentName ?? findAgent(h, id)?.name ?? NATIVE_NAMES[id] ?? id;
}

/** Short form for "Message …" and "… wants to": "Claude", "Codex", else the display name. */
export function agentShortLabel(s: Pick<SessionInfo, 'agent' | 'agentName'>, h?: HostInfo | null): string {
  return SHORT_NAMES[s.agent ?? 'claude'] ?? agentLabel(s, h);
}
