import type {
  AgentId,
  AgentInfo,
  EffortOption,
  HostInfo,
  ModelOption,
  PermissionMode,
  SessionInfo,
} from '@phone-code/protocol';

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

/**
 * The models to offer, with display names when the daemon sends them
 * (`modelOptions`), else the bare ids of older daemons.
 */
export function modelOptions(
  src: { models?: string[]; modelOptions?: ModelOption[] } | undefined,
): ModelOption[] {
  if (!src) return [];
  if (src.modelOptions?.length) return src.modelOptions;
  return (src.models ?? []).map((id) => ({ id }));
}

/** A session's models: its own list (reported once the agent started), else the agent's. */
export function sessionModels(s: SessionInfo, h: HostInfo | null | undefined): ModelOption[] {
  const own = modelOptions(s);
  return own.length ? own : modelOptions(findAgent(h, s.agent ?? 'claude'));
}

/**
 * The option a session's model id stands for. Agents report either the alias
 * that was picked ("opus") or the concrete model ("claude-opus-4-7"); the
 * latter maps to the option that resolves to it, preferring a named model
 * over "default". No model at all is the default option.
 */
export function currentModel(model: string | undefined, options: ModelOption[]): ModelOption | undefined {
  if (model === undefined) return options.find((o) => o.isDefault);
  return (
    options.find((o) => o.id === model) ??
    options.find((o) => o.resolved === model && !o.isDefault) ??
    options.find((o) => o.resolved === model)
  );
}

/** Short label for the composer chip and title: the model in use, e.g. "Opus 4.7". */
export function modelLabel(model: string | undefined, options: ModelOption[]): string | undefined {
  const cur = currentModel(model, options);
  if (!cur) return model;
  if (cur.isDefault) {
    // "Default (recommended)" says little; name what it currently runs.
    const target = options.find(
      (o) => !o.isDefault && o.resolved !== undefined && o.resolved === cur.resolved,
    );
    return target?.name ?? cur.description ?? cur.name ?? 'Default';
  }
  return cur.name ?? cur.id;
}

/**
 * The thinking levels a session offers: its own list when they do not depend
 * on the model (ACP agents), else the current model's. Empty: no such setting.
 */
export function sessionEfforts(s: SessionInfo, h: HostInfo | null | undefined): EffortOption[] {
  if (s.efforts?.length) return s.efforts;
  return currentModel(s.model, sessionModels(s, h))?.efforts ?? [];
}

/** The modes every agent had before `auto`; offered when an agent does not list its own. */
export const CLASSIC_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
