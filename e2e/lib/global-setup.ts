import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO } from './daemon.ts';

/**
 * Builds the web app the daemon serves, so the suite always tests the current
 * source, and snapshots it into a private directory: a rebuild of
 * packages/web/dist while the suite runs must not swap chunks under the pages.
 */
export default function globalSetup(): () => void {
  if (process.env['E2E_SKIP_BUILD'] !== '1') {
    execFileSync('bun', ['run', '--filter', '@phone-code/web', 'build'], { cwd: REPO, stdio: 'pipe' });
  }
  const dir = mkdtempSync(join(tmpdir(), 'phonecode-e2e-web-'));
  cpSync(join(REPO, 'packages/web/dist'), dir, { recursive: true });
  process.env['E2E_WEB_DIR'] = dir;
  return () => rmSync(dir, { recursive: true, force: true });
}
