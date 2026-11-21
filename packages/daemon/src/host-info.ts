import { homedir, hostname, userInfo } from 'node:os';
import type {
  AgentId,
  AgentInfo,
  AgentKind,
  ConnectionInfo,
  HostInfo,
  SlashCommand,
} from '@phone-code/protocol';
import { agentDisplayName, listAdapters, type AdapterRegistry, type AgentAdapter } from './agents/types.ts';
import { DAEMON_VERSION } from './config.ts';
import { log } from './log.ts';

export function userShell(): string {
  const shell = process.env['SHELL'];
  if (shell !== undefined && shell !== '') return shell;
  try {
    const fromPasswd = userInfo().shell;
    if (fromPasswd !== null && fromPasswd !== '') return fromPasswd;
  } catch {
    // no passwd entry
  }
  return '/bin/sh';
}

function userName(): string {
  const fromEnv = process.env['USER'] ?? process.env['LOGNAME'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    const info = userInfo();
    // Bun reports "unknown" when there is no passwd entry.
    if (info.username !== '' && info.username !== 'unknown') return info.username;
    return info.uid === 0 ? 'root' : `uid ${info.uid}`;
  } catch {
    return 'user';
  }
}

type AgentAvailability = HostInfo['agents'][number];

const DETECT_TIMEOUT_MS = 5000;

type Detected = Awaited<ReturnType<AgentAdapter['detect']>>;

async function detectAdapter(adapter: AgentAdapter): Promise<Detected> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Detected>((resolve) => {
    timer = setTimeout(() => resolve({ available: false }), DETECT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([adapter.detect(), timeout]);
  } catch (err) {
    log.warn(`detecting ${adapter.kind} failed`, err);
    return { available: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Every adapter, detected: native first, then ACP agents (all listed, available or not). */
async function detectAll(adapters: AdapterRegistry): Promise<AgentInfo[]> {
  const list = listAdapters(adapters);
  const found = await Promise.all(list.map((a) => detectAdapter(a)));
  return list.map((a, i) => {
    const d = found[i] ?? { available: false };
    const impl = a.impl ?? 'native';
    const info: AgentInfo = {
      id: a.kind,
      name: agentDisplayName(adapters, a.kind),
      impl,
      available: d.available,
    };
    if (d.version !== undefined) info.version = d.version;
    if (d.models !== undefined) info.models = d.models;
    if (d.modelOptions !== undefined) info.modelOptions = d.modelOptions;
    if (d.permissionModes !== undefined) info.permissionModes = d.permissionModes;
    if (d.commands !== undefined) info.commands = d.commands;
    if (d.setupHint !== undefined) info.setupHint = d.setupHint;
    if (impl === 'acp') info.source = a.source ?? 'builtin';
    return info;
  });
}

function isNativeKind(id: string): id is AgentKind {
  return id === 'claude' || id === 'codex';
}

/** Host description for `ready`. Agent detection runs once, in the background. */
export class HostInfoProvider {
  private readonly base: Omit<HostInfo, 'agents'>;
  private readonly catalog: Promise<AgentInfo[]>;
  private connection: ConnectionInfo | undefined;

  constructor(adapters: AdapterRegistry) {
    this.base = {
      name: hostname(),
      platform: process.platform,
      user: userName(),
      home: homedir(),
      daemonVersion: DAEMON_VERSION,
      shell: userShell(),
    };
    this.catalog = detectAll(adapters);
  }

  get short(): Pick<HostInfo, 'name' | 'platform' | 'user'> {
    return { name: this.base.name, platform: this.base.platform, user: this.base.user };
  }

  /** How phones reach this daemon (set once the public URL is known). */
  setConnection(c: ConnectionInfo): void {
    this.connection = c;
  }

  /** Slash commands an agent offers before a session exists. */
  async commandsFor(agent: AgentId): Promise<SlashCommand[] | undefined> {
    return (await this.catalog).find((a) => a.id === agent)?.commands;
  }

  async full(): Promise<HostInfo> {
    const catalog = await this.catalog;
    // `agents` keeps its old shape (native kinds only) for older clients.
    const agents: AgentAvailability[] = catalog.flatMap((a) =>
      a.impl === 'native' && isNativeKind(a.id)
        ? [
            {
              kind: a.id,
              available: a.available,
              ...(a.version === undefined ? {} : { version: a.version }),
              ...(a.models === undefined ? {} : { models: a.models }),
            },
          ]
        : [],
    );
    return {
      ...this.base,
      agents,
      agentCatalog: catalog,
      ...(this.connection === undefined ? {} : { connection: this.connection }),
    };
  }
}
