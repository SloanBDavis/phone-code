import type { AdapterRegistry, AgentAdapter } from './types.js';
import type { AgentKind } from '@phone-code/protocol';

export type { AdapterRegistry, AgentAdapter, AgentSession, AgentEvents, AgentStartOptions } from './types.js';

function stub(kind: AgentKind): AgentAdapter {
  return {
    kind,
    async detect() {
      return { available: false };
    },
    async start() {
      throw new Error(`${kind} adapter not implemented yet`);
    },
    async listResumable() {
      return [];
    },
  };
}

/** Build the adapter registry. */
export function createAdapters(): AdapterRegistry {
  return { claude: stub('claude'), codex: stub('codex') };
}
