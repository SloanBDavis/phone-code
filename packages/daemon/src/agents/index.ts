import type { AdapterRegistry } from './types.ts';
import { createClaudeAdapter } from './claude.ts';
import { createCodexAdapter } from './codex.ts';

export type { AdapterRegistry, AgentAdapter, AgentEvents, AgentSession, AgentStartOptions } from './types.ts';

/** Build the adapter registry (one adapter per agent CLI). */
export function createAdapters(): AdapterRegistry {
  return { claude: createClaudeAdapter(), codex: createCodexAdapter() };
}
