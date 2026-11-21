#!/usr/bin/env node
// npm launcher for phone-code (`npx phone-code`, `bunx phone-code`).
// Finds the @phone-code/<os>-<arch> package that npm installed as an optional
// dependency and runs its phonecode binary with the same arguments.
// Copied into release/npm/phone-code/bin/ by scripts/build-release.ts.
'use strict';

const { spawn } = require('node:child_process');
const { accessSync, chmodSync, constants, existsSync } = require('node:fs');
const path = require('node:path');

const SUPPORTED = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];
const platform = `${process.platform}-${process.arch}`;

/** Prints the message and exits; never returns. */
function fail(message) {
  process.stderr.write(`phone-code: ${message}\n`);
  return process.exit(1);
}

/** The binary to run. PHONECODE_BINARY overrides the lookup (for testing a local build). */
function findBinary() {
  if (process.env.PHONECODE_BINARY) return process.env.PHONECODE_BINARY;
  if (!SUPPORTED.includes(platform)) {
    fail(`no prebuilt binary for ${platform}. Supported: ${SUPPORTED.join(', ')}.`);
  }
  const pkg = `@phone-code/${platform}`;
  try {
    return path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'bin', 'phonecode');
  } catch {
    return fail(
      `the ${pkg} package is missing. It is an optional dependency of phone-code;\n` +
        'reinstall without --no-optional / --omit=optional, or use the install script:\n' +
        '  curl -fsSL https://raw.githubusercontent.com/SloanBDavis/phone-code/main/install.sh | sh',
    );
  }
}

const bin = findBinary();
if (!existsSync(bin)) fail(`${bin} does not exist`);
try {
  accessSync(bin, constants.X_OK);
} catch {
  // Some package managers drop the executable bit.
  try {
    chmodSync(bin, 0o755);
  } catch {
    // spawn below reports the real error
  }
}

const child = spawn(bin, process.argv.slice(2), { stdio: 'inherit' });
child.on('error', (err) => fail(`could not run ${bin}: ${err.message}`));
child.on('exit', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else {
    process.exit(code === null ? 1 : code);
  }
});

// The terminal delivers Ctrl+C to the whole process group, so the daemon gets
// SIGINT itself; stay alive until it has shut down. Forward signals sent to
// this process alone (kill <pid>).
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (sig !== 'SIGINT' && child.exitCode === null) child.kill(sig);
  });
}
