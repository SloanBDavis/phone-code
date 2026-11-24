/**
 * Connecting Cursor's desktop app: a hook script in phone-code's state folder,
 * listed in Cursor's user hooks (~/.cursor/hooks.json) next to whatever is
 * already there. The script posts each hook event to the running daemon
 * (agents/cursor-app.ts) and prints the daemon's answer; when phone-code is not
 * running it prints `{}` at once, so Cursor carries on as if it were not there.
 */
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stateDir } from '../config.ts';
import type { CursorStatus } from '@phone-code/protocol';
import { UserError } from '../util/errors.ts';
import { isRecord } from '../util/guards.ts';
import { writeFileAtomic } from '../util/files.ts';

/** The hook events phone-code listens to. */
export const CURSOR_EVENTS = [
  'beforeSubmitPrompt',
  'afterAgentThought',
  'afterAgentResponse',
  'postToolUse',
  'postToolUseFailure',
  'afterFileEdit',
  'stop',
  'sessionEnd',
] as const;

const SCRIPT_NAME = 'cursor-hook.sh';
/**
 * A `stop` hook may wait this long for a reply from the phone: a little more
 * than the daemon's own limit (DEFAULT_HOLD_MS in agents/cursor-app.ts).
 */
const STOP_TIMEOUT_S = 8 * 60 * 60 + 5 * 60;

export function cursorDir(): string {
  return process.env['PHONECODE_CURSOR_DIR'] || join(homedir(), '.cursor');
}

const hooksFile = (): string => join(cursorDir(), 'hooks.json');
const scriptPath = (): string => join(stateDir(), SCRIPT_NAME);

/** Cursor is (or was) used on this computer. */
export async function cursorInstalled(): Promise<boolean> {
  if (existsSync(cursorDir())) return true;
  if (process.platform === 'darwin') return existsSync('/Applications/Cursor.app');
  return false;
}

// POSIX sh + curl only. The control file sits next to the script; the daemon
// answers /_control/* on loopback to requests carrying its token.
const SCRIPT = `#!/bin/sh
# phone-code: forwards Cursor agent hooks to phone-code so you can follow your
# Cursor chats on your phone and reply when a turn ends. Installed by
# \`phonecode cursor connect\`; remove with \`phonecode cursor disconnect\`.
EVENT="$1"
DIR="$(cd "$(dirname "$0")" && pwd)"
CONTROL="$DIR/control.json"
if [ ! -f "$CONTROL" ] || ! command -v curl >/dev/null 2>&1; then
  cat >/dev/null
  echo '{}'
  exit 0
fi
PORT=$(sed -n 's/.*"port":\\([0-9][0-9]*\\).*/\\1/p' "$CONTROL")
TOKEN=$(sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p' "$CONTROL")
if [ -z "$PORT" ] || [ "$PORT" = "0" ] || [ -z "$TOKEN" ]; then
  cat >/dev/null
  echo '{}'
  exit 0
fi
MAX=10
[ "$EVENT" = "stop" ] && MAX=${STOP_TIMEOUT_S - 30}
OUT=$(curl -s -m "$MAX" -X POST -H "x-phonecode-control: $TOKEN" -H 'content-type: application/json' \\
  --data-binary @- "http://127.0.0.1:$PORT/_control/cursor/$EVENT" 2>/dev/null)
case "$OUT" in
  \\{*) echo "$OUT" ;;
  *) echo '{}' ;;
esac
exit 0
`;

type HookEntry = Record<string, unknown>;
interface HooksFile {
  rest: Record<string, unknown>;
  version: number;
  hooks: Record<string, HookEntry[]>;
}

const ours = (h: HookEntry): boolean =>
  typeof h['command'] === 'string' && h['command'].includes(SCRIPT_NAME);

async function readHooks(): Promise<HooksFile> {
  let text: string;
  try {
    text = await readFile(hooksFile(), 'utf8');
  } catch {
    return { rest: {}, version: 1, hooks: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (isRecord(parsed)) {
    const { version, hooks, ...rest } = parsed;
    const lists = isRecord(hooks) ? hooks : {};
    return {
      rest,
      version: typeof version === 'number' ? version : 1,
      hooks: Object.fromEntries(
        Object.entries(lists).map(([event, list]) => [
          event,
          Array.isArray(list) ? list.filter(isRecord) : [],
        ]),
      ),
    };
  }
  // Never overwrite a file we cannot read: the user's other hooks are in it.
  throw new UserError(`${hooksFile()} is not valid JSON; fix it (or move it away) and connect again.`);
}

/** Whether phone-code's hooks are installed. */
export async function cursorConnected(): Promise<boolean> {
  try {
    const f = await readHooks();
    return Object.values(f.hooks).some((list) => list.some(ours));
  } catch {
    return false;
  }
}

/** What clients show: Cursor installed, phone-code connected. */
export async function cursorStatus(): Promise<CursorStatus> {
  return { installed: await cursorInstalled(), connected: await cursorConnected() };
}

/** Installs the script and adds phone-code's hooks, keeping every other hook. Idempotent. */
export async function connectCursor(): Promise<void> {
  const f = await readHooks();
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  await writeFile(scriptPath(), SCRIPT, { mode: 0o755 });
  await chmod(scriptPath(), 0o755);
  const hooks: Record<string, HookEntry[]> = { ...f.hooks };
  const quoted = `"${scriptPath()}"`;
  for (const event of CURSOR_EVENTS) {
    const list = (hooks[event] ?? []).filter((h) => !ours(h));
    list.push({
      command: `${quoted} ${event}`,
      ...(event === 'stop' ? { timeout: STOP_TIMEOUT_S, loop_limit: null } : { timeout: 15 }),
    });
    hooks[event] = list;
  }
  await mkdir(cursorDir(), { recursive: true });
  await writeFileAtomic(
    hooksFile(),
    `${JSON.stringify({ ...f.rest, version: f.version, hooks }, null, 2)}\n`,
  );
}

/**
 * Brings an already connected Cursor up to this version's script and hook
 * settings (a daemon update may change either). Does nothing when not connected
 * or already current.
 */
export async function refreshCursor(): Promise<void> {
  const f = await readHooks();
  const mine = Object.values(f.hooks).flatMap((list) => list.filter(ours));
  if (mine.length === 0) return;
  const script = await readFile(scriptPath(), 'utf8').catch(() => '');
  const stop = (f.hooks['stop'] ?? []).find(ours);
  if (script === SCRIPT && stop?.['timeout'] === STOP_TIMEOUT_S) return;
  await connectCursor();
}

/** Removes phone-code's hooks (and only those). */
export async function disconnectCursor(): Promise<void> {
  if (!existsSync(hooksFile())) return;
  const f = await readHooks();
  const hooks: Record<string, HookEntry[]> = {};
  for (const [event, list] of Object.entries(f.hooks)) {
    const kept = list.filter((h) => !ours(h));
    if (kept.length > 0) hooks[event] = kept;
  }
  await writeFileAtomic(
    hooksFile(),
    `${JSON.stringify({ ...f.rest, version: f.version, hooks }, null, 2)}\n`,
  );
}
