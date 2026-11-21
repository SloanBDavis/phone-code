import type { SessionInfo } from '@phone-code/protocol';
import { alertDialog, toast } from '../ui/overlay';
import { client } from './client';
import { popToRoot, stack } from './nav';
import { chatOf, dropChat } from './state';
import { copyText, haptic } from './util';

/** Session-level actions shared by the list (swipe) and the chat title menu. */

export async function renameSession(s: SessionInfo): Promise<void> {
  const title = await alertDialog({
    title: 'Rename session',
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
  const top = stack.value[stack.value.length - 1]?.route;
  if (top?.name === 'session' && top.id === s.id) popToRoot();
  try {
    await client.rpc({ t: 'session.delete', sessionId: s.id });
    dropChat(s.id);
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Delete failed', 'warn');
  }
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
