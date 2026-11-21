import { join } from 'node:path';
import { expect, test } from '../lib/fixtures.ts';
import { REPO } from '../lib/daemon.ts';
import { createSession, send } from '../lib/ui.ts';

test.use({
  daemonOptions: {
    env: { PHONECODE_GEMINI_BIN: join(REPO, 'e2e/fakes/fake-acp.mjs'), FAKE_ACP_REQUIRE_AUTH: '1' },
  },
});

test('an ACP agent that is not signed in tells the user to log in on the computer', async ({ phone }) => {
  await createSession(phone, 'gemini');
  await send(phone, 'hello');
  await expect(phone.testId('chat-item-notice').last()).toContainText(/log in/i);
});
