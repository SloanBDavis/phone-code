import { homedir } from 'node:os';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };

export const DAEMON_VERSION: string = pkg.version;
export const DEFAULT_PORT = 7777;

/**
 * The screen worker entry. In the compiled executable it is a separate
 * embedded entrypoint addressed by its relative name; in dev it sits next to
 * this module.
 */
export const SCREEN_WORKER_URL = Bun.isStandaloneExecutable
  ? './screen-worker.ts'
  : new URL('./screen-worker.ts', import.meta.url).href;

/** State directory: `~/.phonecode`, overridable with `PHONECODE_HOME`. */
export function stateDir(): string {
  const fromEnv = process.env['PHONECODE_HOME'];
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.phonecode');
}

export interface StatePaths {
  root: string;
  devices: string;
  sessions: string;
  transcripts: string;
  terminals: string;
  vapid: string;
  control: string;
}

export function statePaths(root: string): StatePaths {
  return {
    root,
    devices: join(root, 'devices.json'),
    sessions: join(root, 'sessions.json'),
    transcripts: join(root, 'transcripts'),
    terminals: join(root, 'terminals'),
    vapid: join(root, 'vapid.json'),
    control: join(root, 'control.json'),
  };
}

export function envFlag(name: string): boolean {
  const v = process.env[name];
  return v === '1' || v === 'true' || v === 'yes';
}
