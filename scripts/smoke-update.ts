/**
 * Smoke test of `phonecode update` on a release binary:
 *
 *   bun scripts/smoke-update.ts <path to an installed phonecode> <release directory>
 *
 * Pretends a newer release is out (a local server answers like GitHub's
 * /releases/latest) and lets the binary update itself from the release
 * directory with install.sh; the binary must be replaced and still run.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [binArg, releaseArg] = process.argv.slice(2);
if (binArg === undefined || releaseArg === undefined) {
  console.error('usage: bun scripts/smoke-update.ts <phonecode> <release directory>');
  process.exit(2);
}
const bin = resolve(binArg);
const release = resolve(releaseArg);
const root = resolve(import.meta.dirname, '..');
const home = mkdtempSync(join(tmpdir(), 'phonecode-smoke-update-'));

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: () =>
    new Response(null, {
      status: 302,
      headers: { location: 'https://github.com/SloanBDavis/phone-code/releases/tag/v999.0.0' },
    }),
});

function fail(message: string): never {
  console.error(`smoke-update: ${message}`);
  process.exit(1);
}

try {
  const before = statSync(bin).ino;
  const proc = Bun.spawn([bin, 'update'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      PHONECODE_HOME: home,
      PHONECODE_LATEST_URL: `http://127.0.0.1:${server.port}/`,
      PHONECODE_INSTALL_SCRIPT: join(root, 'install.sh'),
      PHONECODE_BASE_URL: `file://${release}`,
    },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  process.stdout.write(out);
  process.stderr.write(err);
  if (code !== 0) fail(`phonecode update exited with ${code}`);
  if (!out.includes('999.0.0 is available')) fail('the newer version was not announced');
  if (!out.includes('Installed phonecode')) fail('nothing was installed');
  if (statSync(bin).ino === before) fail('the executable was not replaced');
  const version = Bun.spawnSync([bin, '--version']);
  if (version.exitCode !== 0) fail('the updated executable does not run');
  console.log(`smoke-update: ok (${version.stdout.toString().trim()})`);
} finally {
  await server.stop(true);
  rmSync(home, { recursive: true, force: true });
}
