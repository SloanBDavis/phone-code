import type { SessionInfo } from '@phone-code/protocol';
import { alertDialog, toast } from '../ui/overlay';
import { client } from './client';
import { currentSessionId, openChat, openNew } from './nav';
import { chatOf, dropChat, host, sessions } from './state';
import { copyText, haptic } from './util';

/** Session-level actions shared by the list (swipe) and the chat title menu. */

export async function renameSession(s: SessionInfo): Promise<void> {
  const title = await alertDialog({
    title: 'Rename chat',
    confirm: 'Save',
    input: { value: s.title, placeholder: 'Title' },
    testid: 'rename-dialog',
  });
  if (!title || title === s.title) return;
  try {
    await client.rpc({ t: 'session.rename', sessionId: s.id, title });
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Rename failed', 'warn');
  }
}

export async function deleteSession(s: SessionInfo): Promise<void> {
  const ok = await alertDialog({
    title: `Delete “${s.title}”?`,
    message:
      s.kind === 'terminal'
        ? 'The shell and anything running in it will be stopped.'
        : 'The agent process on your computer will be stopped.',
    confirm: 'Delete',
    destructive: true,
    testid: 'delete-dialog',
  });
  if (!ok) return;
  haptic('warning');
  if (currentSessionId() === s.id) openNew();
  try {
    await client.rpc({ t: 'session.delete', sessionId: s.id });
    dropChat(s.id);
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Delete failed', 'warn');
  }
}

/** Local view of the archived flag until the daemon's session list agrees (instant, undoable). */
function setArchivedLocally(id: string, archived: boolean): void {
  sessions.value = sessions.value.map((x) => (x.id === id ? { ...x, archived } : x));
}

/**
 * Archive: the chat leaves the sidebar on every device (the daemon keeps it,
 * and "All chats" still finds it). Instant, with Undo in the toast. A daemon
 * without archiving answers with an error: the row comes back and says why.
 */
export async function archiveSession(s: SessionInfo, archived = true): Promise<void> {
  haptic(archived ? 'medium' : 'light');
  setArchivedLocally(s.id, archived);
  if (archived) {
    if (currentSessionId() === s.id) openNew();
    toast('Archived', 'check', {
      action: { label: 'Undo', run: () => void archiveSession(s, false), testid: 'toast-undo' },
    });
  }
  try {
    await client.rpc({ t: 'session.archive', sessionId: s.id, archived });
  } catch {
    setArchivedLocally(s.id, !archived);
    toast('Archiving needs a newer phone-code on your computer', 'warn');
  }
}

/** Open a chat from "All chats": it joins the sidebar again if it was archived. */
export function openSession(id: string): void {
  const s = sessions.value.find((x) => x.id === id);
  if (s?.archived) void archiveSession(s, false);
  openChat(id);
}

export function lastResponse(sessionId: string): string | null {
  const c = chatOf(sessionId);
  const ids = c.ids.value;
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i];
    const item = id ? c.items.get(id)?.value : undefined;
    if (item?.kind === 'text' && item.text.trim()) return item.text;
  }
  return null;
}

export async function copyLastResponse(sessionId: string): Promise<void> {
  const text = lastResponse(sessionId);
  if (!text) {
    toast('Nothing to copy yet', 'info');
    return;
  }
  if (await copyText(text)) toast('Copied', 'check');
}

/**
 * Follow Cursor's desktop app (or stop): the host adds or removes its hook in
 * Cursor's hooks.json and answers with the new status, which this host's info
 * takes on. Throws what the host said when it could not.
 */
export async function setCursorConnected(on: boolean): Promise<void> {
  const cursor = await client.rpc({ t: on ? 'cursor.connect' : 'cursor.disconnect' });
  const h = host.peek();
  if (h) host.value = { ...h, cursor };
}
