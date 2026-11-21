import { homedir, hostname, userInfo } from 'node:os';
import type { AgentKind, HostInfo } from '@phone-code/protocol';
import type { AdapterRegistry } from './agents/types.ts';
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

async function detectOne(adapters: AdapterRegistry, kind: AgentKind): Promise<AgentAvailability> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<AgentAvailability>((resolve) => {
    timer = setTimeout(() => resolve({ kind, available: false }), DETECT_TIMEOUT_MS);
  });
  try {
    const found = adapters[kind].detect().then((r) => ({ kind, ...r }));
    return await Promise.race([found, timeout]);
  } catch (err) {
    log.warn(`detecting ${kind} failed`, err);
    return { kind, available: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Host description for `ready`. Agent detection runs once, in the background. */
export class HostInfoProvider {
  private readonly base: Omit<HostInfo, 'agents'>;
  private readonly agents: Promise<AgentAvailability[]>;

  constructor(adapters: AdapterRegistry) {
    this.base = {
      name: hostname(),
      platform: process.platform,
      user: userName(),
      home: homedir(),
      daemonVersion: DAEMON_VERSION,
      shell: userShell(),
    };
    this.agents = Promise.all([detectOne(adapters, 'claude'), detectOne(adapters, 'codex')]);
  }

  get short(): Pick<HostInfo, 'name' | 'platform' | 'user'> {
    return { name: this.base.name, platform: this.base.platform, user: this.base.user };
  }

  async full(): Promise<HostInfo> {
    return { ...this.base, agents: await this.agents };
  }
}
