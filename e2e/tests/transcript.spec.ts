/**
 * The transcript around a turn: a sign that something is happening from the moment a
 * message is sent, the steps folding into one line while the agent works and after, and
 * the way back to the bottom when the reader has scrolled up.
 */
import { expect, test } from '../lib/fixtures.ts';
import { newChat, send, shot, waitTurn } from '../lib/ui.ts';

test('a turn with many steps folds into one line, live and once done, and opens on a click', async ({
  phone,
}) => {
  await newChat(phone, 'claude');
  await send(phone, 'busy work please');

  // Sent: something is happening before the agent's first word.
  await expect(phone.testId('working')).toBeVisible();

  // A few steps in, they are one line that says what is going on now and counts them.
  const work = phone.testId('chat-work');
  await expect(work).toHaveCount(1, { timeout: 15_000 });
  await expect(work).toHaveAttribute('data-live', 'true');
  const head = phone.testId('work-toggle');
  await expect(head).toContainText(/Reading|Working/);
  await expect(head).toContainText(/\d steps/);
  // The steps themselves are not in the way; the line already says the agent is at work.
  await expect(phone.testId('chat-item-tool')).toHaveCount(0);
  await expect(phone.testId('working')).toHaveCount(0);
  await shot(phone, 'work-live');

  // Open while it runs: every step so far, and the ones that follow join them.
  await head.click();
  await expect(phone.testId('work-body')).toBeVisible();
  await expect(phone.testId('chat-item-tool').first()).toBeVisible();
  await head.click();
  await expect(phone.testId('chat-item-tool')).toHaveCount(0);

  // Done: the answer follows the folded line, which says how long and how much.
  await waitTurn(phone, 1, 'completed', { folded: true });
  await expect(work).toHaveAttribute('data-live', 'false');
  await expect(head).toContainText(/^Worked/);
  await expect(head).toContainText('6 steps');
  await expect(phone.testId('chat-item-text')).toHaveCount(1);
  await expect(phone.testId('chat-item-text')).toContainText('All six parts are in order.');
  await expect(phone.testId('working')).toHaveCount(0);
  await shot(phone, 'work-done');

  // A click shows all of it: what it said on the way and the six reads.
  await head.click();
  await expect(phone.testId('chat-item-tool')).toHaveCount(6);
  await expect(phone.testId('work-body')).toContainText('Half way through.');
  await expect(phone.testId('work-body')).toContainText('On it');
  await shot(phone, 'work-open');
});

test('a turn with a step or two shows them as they are', async ({ phone }) => {
  await newChat(phone, 'claude');
  await send(phone, 'screenshot');
  await waitTurn(phone, 1, 'completed', { folded: true });
  await expect(phone.testId('chat-work')).toHaveCount(0);
  await expect(phone.testId('chat-item-tool')).toHaveCount(1);
});

test('scrolled up, a button goes back to the latest message', async ({ phone }) => {
  // A short window, so one answer is more than a screen.
  await phone.page.setViewportSize({ width: 390, height: 420 });
  await newChat(phone, 'claude');
  await send(phone, 'a long answer');
  await waitTurn(phone, 1);
  const jump = phone.testId('jump-latest');
  const scroller = phone.page.locator('.chat-scroll');
  const fromBottom = (): Promise<number> =>
    scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

  expect(await scroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(300);
  // At the bottom there is nothing to go back to.
  await expect(jump).not.toHaveClass(/\bshow\b/);
  // Nothing new arrives; scrolling up alone brings the button.
  await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
  await expect(jump).toHaveClass(/\bshow\b/);
  await shot(phone, 'jump-latest');
  await jump.click();
  await expect.poll(fromBottom).toBeLessThan(4);
  await expect(jump).not.toHaveClass(/\bshow\b/);
});

test('a sub-agent at work is named above the composer, with what it is doing, and opens to watch', async ({
  phone,
}) => {
  await newChat(phone, 'claude');
  await send(phone, 'slow agent please');
  const chip = phone.testId('running-chip');
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText('Inspect the repo');
  // How far it is and what it is running right now.
  await expect(phone.testId('running-steps')).toHaveText('Running ls · 1 step');
  // In the chat, the same in one compact line: none of its steps spill into the thread.
  const card = phone.testId('chat-item-task');
  await expect(card.getByTestId('task-status')).toHaveText('Running ls · 1 step');
  await expect(card.locator('[data-testid="chat-item-tool"]')).toHaveCount(0);
  await shot(phone, 'agent-running');

  await chip.click();
  const sheet = phone.testId('watch-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('h2')).toHaveText('Inspect the repo');
  await expect(sheet.getByTestId('chat-item-task')).toHaveAttribute('data-status', 'running');
  await expect(sheet).toContainText('List the files and report back.');
  await expect(sheet.locator('[data-testid="chat-item-tool"][data-tool="Bash"]')).toHaveAttribute(
    'data-status',
    'running',
  );
  await shot(phone, 'agent-watch');
  // It finishes while watched: the card says so, and nothing is left running.
  await expect(sheet.getByTestId('chat-item-task')).toHaveAttribute('data-status', 'done', {
    timeout: 15_000,
  });
  await expect(sheet).toContainText('The repo has README.md, package.json and src.');
  await sheet.getByTestId('watch-close').click();
  await expect(sheet).toBeHidden();
  await expect(phone.testId('running-strip')).toHaveCount(0);
  await waitTurn(phone, 1);
});
