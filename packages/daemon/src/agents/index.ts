import type { AdapterRegistry, AgentAdapter } from './types.ts';
import { createAcpAdapter } from './acp/index.ts';
import { loadAcpAgents } from './acp/config.ts';
import { createClaudeAdapter } from './claude/index.ts';
import { createCodexAdapter } from './codex/index.ts';
import { log } from '../log.ts';

export type {
  AdapterRegistry,
  AgentAdapter,
  AgentEvents,
  AgentSession,
  AgentStartOptions,
  HarnessHistory,
} from './types.ts';

/**
 * The harnesses with their own adapter, in the order the phone lists them.
 * Adding one is a folder under agents/ and a line here (agents/README.md).
 */
export const NATIVE_HARNESSES: ReadonlyArray<() => AgentAdapter> = [createClaudeAdapter, createCodexAdapter];

/**
 * Build the adapter registry: the native harnesses, then one ACP adapter per
 * preset / agents.json entry (acp/config.ts). A native harness always wins
 * over an ACP entry with the same id.
 */
export function createAdapters(
  native: ReadonlyArray<() => AgentAdapter> = NATIVE_HARNESSES,
): AdapterRegistry {
  const reg: AdapterRegistry = {};
  for (const make of native) {
    const a = make();
    if (reg[a.kind] !== undefined) {
      log.warn(`two harnesses have the id "${a.kind}": keeping the first`);
      continue;
    }
    reg[a.kind] = a;
  }
  for (const cfg of loadAcpAgents(Object.keys(reg))) reg[cfg.id] ??= createAcpAdapter(cfg);
  return reg;
}
