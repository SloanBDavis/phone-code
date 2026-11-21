import { expect, test, type Phone } from '../lib/fixtures.ts';
import { back, createSession, lastText, row, send, waitTurn } from '../lib/ui.ts';

const LONG = `Here is a long answer: ${Array.from({ length: 100 }, (_, i) => `word${i + 1}`).join(' ')}.`;

const transcript = (p: Phone): Promise<string | null> => p.testId('transcript').textContent();

/** Opens an existing session on another (freshly paired) phone. */
async function follow(phone: Phone, sessionId: string): Promise<void> {
  await phone.pair();
  await row(phone, sessionId).click();
  await expect(phone.testId('screen-chat')).toHaveAttribute('data-session-id', sessionId);
}

test('dropping the connection mid-stream loses and duplicates nothing', async ({ phone, newPhone }) => {
  const id = await createSession(phone, 'claude');
  const watcher = await newPhone();
  await follow(watcher, id);

  await send(phone, 'something long');
  await expect(lastText(phone)).toContainText('word3');
  await phone.goOffline();
  // The agent keeps streaming while this phone is away (the other phone sees it).
  await expect(lastText(watcher)).toContainText('word40', { timeout: 20_000 });
  await expect(lastText(phone)).not.toContainText('word40');
  await phone.goOnline();
  await waitTurn(phone, 1);
  await expect(lastText(phone)).toHaveText(LONG);
  await expect(lastText(watcher)).toHaveText(LONG);

  // Twice more, including a drop while the stream ends.
  await send(phone, 'long again');
  await expect(phone.testId('chat-item-text').nth(1)).toContainText('word2');
  await phone.goOffline();
  await waitTurn(watcher, 2);
  await phone.goOnline();
  await waitTurn(phone, 2);
  await expect(phone.testId('chat-item-text')).toHaveCount(2);
  await expect(phone.testId('chat-item-text').nth(1)).toHaveText(LONG);
  await expect(phone.testId('chat-item-user')).toHaveCount(2);
});

test('a message sent while offline is delivered once on reconnect', async ({ phone }) => {
  await createSession(phone, 'claude');
  await phone.goOffline();
  await expect(phone.testId('chat-title')).toContainText('Offline');
  await send(phone, 'hello from the tunnel');
  await expect(phone.testId('chat-item-pending')).toHaveAttribute('data-status', 'sending');
  await phone.goOnline();
  await waitTurn(phone, 1);
  await expect(phone.testId('chat-title')).toContainText('Ready');
  await expect(phone.testId('chat-item-user')).toHaveCount(1);
  await expect(phone.testId('chat-item-pending')).toHaveCount(0);
});

test('two phones stay in sync and share permission prompts', async ({ phone, newPhone }) => {
  const id = await createSession(phone, 'claude');
  const other = await newPhone();
  await follow(other, id);

  await send(phone, 'hello from phone one');
  await waitTurn(other, 1);
  await expect(other.testId('chat-item-user')).toHaveText('hello from phone one');
  await expect(lastText(other)).toHaveText(await lastText(phone).innerText());

  await send(other, 'run tests from phone two');
  const permA = phone.testId('chat-item-permission');
  const permB = other.testId('chat-item-permission');
  await expect(permA).toHaveAttribute('data-status', 'pending');
  await expect(permB).toHaveAttribute('data-status', 'pending');
  // Answer on phone two; phone one's card resolves by itself.
  await permB.getByTestId('permission-allow').click();
  await expect(permA).toHaveAttribute('data-status', 'allowed');
  await waitTurn(phone, 2);
  await waitTurn(other, 2);
  await expect.poll(() => transcript(phone)).toBe(await transcript(other));

  // And the other way around, with a question.
  await send(phone, 'ask me');
  await expect(other.testId('chat-item-question')).toHaveAttribute('data-status', 'pending');
  await phone.testId('chat-item-question').getByTestId('question-option').nth(1).click();
  await phone.testId('chat-item-question').getByTestId('question-submit').click();
  await expect(other.testId('chat-item-question')).toHaveAttribute('data-status', 'answered');
  await waitTurn(other, 3);
});

test('restarting the daemon mid-conversation continues the same session', async ({ phone, daemon }) => {
  const id = await createSession(phone, 'claude');
  await send(phone, 'hello');
  await waitTurn(phone, 1);
  await send(phone, 'something long');
  await expect(lastText(phone)).toContainText('word5');

  // While the daemon is down the browser logs failed reconnects.
  phone.allowConsole(/WebSocket connection to .* failed/);
  await daemon.restart();
  await expect(phone.testId('screen-chat')).toHaveAttribute('data-session-id', id);
  // Back online with the transcript intact, the interrupted answer settled.
  await expect(lastText(phone)).toHaveAttribute('data-streaming', 'false', { timeout: 20_000 });
  await expect(phone.testId('chat-item-user')).toHaveCount(2);
  await expect(phone.testId('chat-title')).not.toContainText('Working');

  await send(phone, 'hello, still there?');
  await waitTurn(phone, 2);
  await expect(lastText(phone)).toContainText('fake Claude');
  await expect(phone.testId('chat-item-user')).toHaveCount(3);
  await back(phone);
  await expect(row(phone, id)).toHaveCount(1);
});

test('resumes a past Claude session from history', async ({ phone, daemon }) => {
  const id = await createSession(phone, 'claude', { folder: daemon.folder('resume') });
  await send(phone, 'hello, remember the word zebra');
  await waitTurn(phone, 1);
  // Close the phone-code session; the agent's own history stays on the host.
  await phone.testId('chat-menu-btn').click();
  await phone.testId('menu-delete').click();
  await phone.testId('delete-dialog-confirm').click();
  await expect(row(phone, id)).toHaveCount(0);

  await phone.testId('new-session').click();
  const past = phone.testId('resume-row').filter({ hasText: 'zebra' });
  await expect(past).toBeVisible();
  await past.click();
  await expect(phone.testId('screen-chat')).toBeVisible();
  await expect(phone.testId('chat-item-user').first()).toContainText('zebra');
  await expect(phone.testId('chat-item-text').first()).toContainText('fake Claude');
  await send(phone, 'hello once more');
  await waitTurn(phone, 1);
  await expect(phone.testId('chat-item-user')).toHaveCount(2);
});
