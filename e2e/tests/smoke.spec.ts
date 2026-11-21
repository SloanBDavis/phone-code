import { expect, test } from '../lib/fixtures.ts';

test('pairs and shows the empty sessions list', async ({ phone }) => {
  await expect(phone.testId('sessions-empty')).toBeVisible();
  await phone.page.screenshot({ path: '/tmp/claude-0/-home-user/27c9d6d3-57b8-58f0-81fd-e737536b93db/scratchpad/e2e/smoke.png' });
});
