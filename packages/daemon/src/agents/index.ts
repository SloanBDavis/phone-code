import type { AdapterRegistry } from './types.ts';
import { createAcpAdapter } from './acp/index.ts';
import { loadAcpAgents } from './acp/config.ts';
import { createClaudeAdapter } from './claude/index.ts';
import { createCodexAdapter } from './codex/index.ts';

export type { AdapterRegistry, AgentAdapter, AgentEvents, AgentSession, AgentStartOptions } from './types.ts';

/**
 * Build the adapter registry: the native adapters, then one ACP adapter per
 * preset / agents.json entry (acp/config.ts). A native adapter always wins
 * over an ACP entry with the same id.
 */
export function createAdapters(): AdapterRegistry {
  const reg: AdapterRegistry = { claude: createClaudeAdapter(), codex: createCodexAdapter() };
  for (const cfg of loadAcpAgents()) reg[cfg.id] ??= createAcpAdapter(cfg);
  return reg;
}
