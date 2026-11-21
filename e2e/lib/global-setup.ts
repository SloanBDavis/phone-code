import { execFileSync } from 'node:child_process';
import { REPO } from './daemon.ts';

/** Build the web app the daemon serves, so the suite always tests the current source. */
export default function globalSetup(): void {
  if (process.env['E2E_SKIP_BUILD'] === '1') return;
  execFileSync('bun', ['run', '--filter', '@phone-code/web', 'build'], { cwd: REPO, stdio: 'pipe' });
}
