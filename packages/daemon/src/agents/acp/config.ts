/**
 * Which ACP (Agent Client Protocol) agents the host offers.
 *
 * Two sources, merged by id:
 *  1. Built-in presets for agents that speak ACP over stdio. Each launch line
 *     comes from the agent's entry in the official ACP registry
 *     (github.com/agentclientprotocol/registry, `distribution.*.args`), and the
 *     command name from the npm package's `bin` (or the registry binary's
 *     `cmd`). Gemini CLI 0.70.0, OpenCode 1.19.6 and Qwen Code 0.28.0 were
 *     also launched for real (initialize + session/new).
 *  2. `agents.json` in the state dir (`$PHONECODE_HOME`, default ~/.phonecode):
 *       { "agents": [ { "id": "my-agent", "name": "My Agent",
 *                       "command": "my-agent", "args": ["--acp"],
 *                       "env": { "KEY": "value" }, "disabled": false } ] }
 *     A bare array works too. An entry with a preset's id overrides that
 *     preset (e.g. to change its command or add env, or `disabled: true` to
 *     hide it). Read once at daemon start.
 *
 * Native adapters always win: the ids `claude` and `codex` are reserved, and
 * the registry's Claude/Codex ACP wrappers are not presets.
 *
 * `PHONECODE_<ID>_BIN` (id upper-cased, non-alphanumerics as `_`, e.g.
 * `PHONECODE_GEMINI_BIN`) replaces a preset's or entry's command; the e2e
 * suite points it at `e2e/fakes/fake-acp.mjs`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stateDir } from '../../config.ts';
import { log } from '../../log.ts';
import { arr, isRec, str } from '../shared/common.ts';

export interface AcpAgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Arguments that print the version (default `--version`); `null` skips the version probe. */
  versionArgs: string[] | null;
  source: 'builtin' | 'config';
  /** Arguments of the agent's terminal sign-in, for the "log in first" notice when it advertises none. */
  loginArgs?: string[];
  /**
   * How this agent words a failure it reports as an ordinary reply instead of
   * an error: an agent message starting with this text that ends the turn is
   * shown as an error notice and the turn as failed. Preset-specific on
   * purpose: the same words from another agent are just text.
   */
  errorReplyPrefix?: string;
}

type Preset = Omit<AcpAgentConfig, 'source' | 'env' | 'versionArgs'> & {
  env?: Record<string, string>;
  versionArgs?: string[] | null;
  /** Where the official installer puts the binary (`~/` = home), tried when `command` is not on PATH. */
  fallbackPaths?: string[];
};

/** Registry-confirmed launch lines (registry ids in comments where they differ). */
export const ACP_PRESETS: readonly Preset[] = [
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: ['--acp'] },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', args: ['acp'] },
  { id: 'qwen', name: 'Qwen Code', command: 'qwen', args: ['--acp'] }, // qwen-code
  { id: 'goose', name: 'goose', command: 'goose', args: ['acp'] },
  { id: 'kimi', name: 'Kimi CLI', command: 'kimi', args: ['acp'] }, // kimi, kimi-code
  { id: 'copilot', name: 'GitHub Copilot', command: 'copilot', args: ['--acp'] }, // github-copilot-cli
  { id: 'cursor', name: 'Cursor', command: 'cursor-agent', args: ['acp'] },
  {
    id: 'auggie',
    name: 'Auggie CLI',
    command: 'auggie',
    args: ['--acp'],
    env: { AUGMENT_DISABLE_AUTO_UPDATE: '1' },
  },
  { id: 'cline', name: 'Cline', command: 'cline', args: ['--acp'] },
  { id: 'qoder', name: 'Qoder CLI', command: 'qodercli', args: ['--acp'] },
  { id: 'vibe', name: 'Mistral Vibe', command: 'vibe-acp', args: [], versionArgs: null }, // mistral-vibe
  // Google Antigravity CLI: `agy acp` is its own ACP server (added in 1.5.0, per the changelog in
  // github.com/google-antigravity/antigravity-cli); checked against the 1.5.13 Linux build
  // (initialize, authenticate, session/new|load|resume|list|close, set_mode, set_config_option,
  // prompt, request_permission, elicitation/create, cancel). It advertises no terminal auth
  // method; its sign-in for headless hosts is `agy acp --login`. The installer puts `agy` in
  // ~/.local/bin, which a daemon started by a service manager may not have on PATH.
  // When its model call fails, agy does not fail the prompt (seen in testing): it sends the
  // failure as an agent message "⚠ agent executor error: …" and ends the turn with end_turn.
  {
    id: 'antigravity',
    name: 'Antigravity',
    command: 'agy',
    args: ['acp'],
    loginArgs: ['acp', '--login'],
    fallbackPaths: ['~/.local/bin/agy'],
    errorReplyPrefix: '⚠ agent executor error:',
  },
];

function presetCommand(p: Preset): string {
  if (p.fallbackPaths === undefined || Bun.which(p.command) !== null) return p.command;
  const found = p.fallbackPaths
    .map((f) => (f.startsWith('~/') ? join(homedir(), f.slice(2)) : f))
    .find(existsSync);
  return found ?? p.command;
}

/** Native adapters (always win) and the new-session sheet's terminal tile. */
const RESERVED = new Set(['claude', 'codex', 'terminal']);
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function binEnvName(id: string): string {
  return `PHONECODE_${id.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')}_BIN`;
}

function stringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRec(v)) return out;
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return out;
}

function readUserEntries(file: string): Array<Partial<AcpAgentConfig> & { id: string; disabled?: boolean }> {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return []; // no config file: presets only
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    log.warn(`ignoring ${file}: not valid JSON`, e);
    return [];
  }
  const list = Array.isArray(data) ? data : isRec(data) ? arr(data['agents']) : [];
  const out: Array<Partial<AcpAgentConfig> & { id: string; disabled?: boolean }> = [];
  for (const e of list) {
    if (!isRec(e)) continue;
    const id = str(e['id'])?.trim().toLowerCase();
    if (id === undefined || !ID_RE.test(id)) {
      log.warn(`ignoring agents.json entry with invalid id ${JSON.stringify(e['id'])} (use [a-z0-9._-])`);
      continue;
    }
    if (RESERVED.has(id)) {
      log.warn(`ignoring agents.json entry "${id}": that id is reserved (native adapter or terminal)`);
      continue;
    }
    const entry: Partial<AcpAgentConfig> & { id: string; disabled?: boolean } = { id };
    const name = str(e['name'])?.trim();
    if (name) entry.name = name.slice(0, 60);
    const command = str(e['command'])?.trim();
    if (command) entry.command = command;
    if (Array.isArray(e['args']))
      entry.args = arr(e['args']).filter((a): a is string => typeof a === 'string');
    if (isRec(e['env'])) entry.env = stringMap(e['env']);
    if (e['versionArgs'] === null) entry.versionArgs = null;
    else if (Array.isArray(e['versionArgs']))
      entry.versionArgs = arr(e['versionArgs']).filter((a): a is string => typeof a === 'string');
    if (e['disabled'] === true) entry.disabled = true;
    out.push(entry);
  }
  return out;
}

/** Path of the user's ACP agent list. */
export function agentsFile(): string {
  return join(stateDir(), 'agents.json');
}

/** Presets merged with `agents.json`, presets first (in preset order), then user-only entries. */
export function loadAcpAgents(env: NodeJS.ProcessEnv = process.env): AcpAgentConfig[] {
  const user = readUserEntries(agentsFile());
  const byId = new Map<string, AcpAgentConfig>();
  for (const p of ACP_PRESETS) {
    byId.set(p.id, {
      id: p.id,
      name: p.name,
      command: presetCommand(p),
      args: [...p.args],
      env: { ...p.env },
      versionArgs: p.versionArgs === undefined ? ['--version'] : p.versionArgs,
      source: 'builtin',
      ...(p.loginArgs ? { loginArgs: [...p.loginArgs] } : {}),
      ...(p.errorReplyPrefix === undefined ? {} : { errorReplyPrefix: p.errorReplyPrefix }),
    });
  }
  for (const u of user) {
    const base = byId.get(u.id);
    if (u.disabled === true) {
      byId.delete(u.id);
      continue;
    }
    if (base === undefined && u.command === undefined) {
      log.warn(`ignoring agents.json entry "${u.id}": "command" is required`);
      continue;
    }
    byId.set(u.id, {
      id: u.id,
      name: u.name ?? base?.name ?? u.id,
      command: u.command ?? base?.command ?? u.id,
      args: u.args ?? base?.args ?? [],
      env: { ...base?.env, ...u.env },
      versionArgs: u.versionArgs === undefined ? (base?.versionArgs ?? ['--version']) : u.versionArgs,
      source: 'config',
      ...(base?.loginArgs ? { loginArgs: base.loginArgs } : {}),
      ...(base?.errorReplyPrefix === undefined ? {} : { errorReplyPrefix: base.errorReplyPrefix }),
    });
  }
  for (const c of byId.values()) {
    const override = env[binEnvName(c.id)];
    if (override !== undefined && override !== '') c.command = override;
  }
  return [...byId.values()];
}
