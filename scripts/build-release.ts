#!/usr/bin/env bun
/**
 * Build the release artifacts into release/:
 *
 *   release/phonecode-<os>-<arch>.tar.gz   one per target: phonecode, LICENSE, README.md
 *   release/SHA256SUMS                      sha256 of every tarball (sha256sum -c format)
 *   release/npm/                            npm packages, ready for `npm publish`:
 *     phone-code/                           launcher (bin: phone-code, phonecode)
 *     <os>-<arch>/                          @phone-code/<os>-<arch>, one binary each
 *     *.tgz                                 `npm pack` output of each, when npm is on PATH
 *
 * Every binary embeds the minified web app (packages/web/dist) and the screen
 * worker; see packages/daemon/scripts/build.ts.
 *
 * Usage: bun scripts/build-release.ts [--targets=linux-x64,darwin-arm64] [--skip-web] [--no-pack]
 */
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const out = join(root, 'release');

interface Target {
  /** Release name, also the npm platform package suffix. */
  name: string;
  /** Bun compile target. x64 uses the baseline build so CPUs without AVX2 work. */
  bun: string;
  os: 'darwin' | 'linux';
  cpu: 'arm64' | 'x64';
}

const ALL: Target[] = [
  { name: 'darwin-arm64', bun: 'bun-darwin-arm64', os: 'darwin', cpu: 'arm64' },
  { name: 'darwin-x64', bun: 'bun-darwin-x64-baseline', os: 'darwin', cpu: 'x64' },
  { name: 'linux-x64', bun: 'bun-linux-x64-baseline', os: 'linux', cpu: 'x64' },
  { name: 'linux-arm64', bun: 'bun-linux-arm64', os: 'linux', cpu: 'arm64' },
];

const flag = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const wanted = flag('targets')?.split(',');
const targets = wanted === undefined ? ALL : ALL.filter((t) => wanted.includes(t.name));
if (wanted !== undefined && targets.length !== wanted.length) {
  console.error(`unknown target in --targets; choose from ${ALL.map((t) => t.name).join(', ')}`);
  process.exit(1);
}

async function run(cmd: string[], cwd = root): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(' ')} exited with ${code}`);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

async function readJson(path: string): Promise<Record<string, unknown>> {
  const v: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isRecord(v)) throw new Error(`${path}: not an object`);
  return v;
}

const daemonPkg = await readJson(join(root, 'packages', 'daemon', 'package.json'));
const version = String(daemonPkg['version']);
const description = String(daemonPkg['description']);
const tag = process.env['GITHUB_REF_NAME'];
if (tag?.startsWith('v') === true && tag.slice(1) !== version) {
  console.error(`tag ${tag} does not match packages/daemon/package.json version ${version}`);
  process.exit(1);
}

const repository = { type: 'git', url: 'git+https://github.com/SloanBDavis/phone-code.git' };
const common = {
  version,
  license: 'MIT',
  repository,
  homepage: 'https://github.com/SloanBDavis/phone-code#readme',
};

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'npm'), { recursive: true });

if (!has('skip-web')) await run(['bun', 'run', '--filter', '@phone-code/web', 'build']);

const sums: string[] = [];
const stage = join(out, 'stage');
for (const t of targets) {
  const dir = join(stage, `phonecode-${t.name}`);
  await mkdir(dir, { recursive: true });
  const binary = join(dir, 'phonecode');
  await run([
    'bun',
    join('packages', 'daemon', 'scripts', 'build.ts'),
    `--target=${t.bun}`,
    `--outfile=${binary}`,
  ]);
  await copyFile(join(root, 'LICENSE'), join(dir, 'LICENSE'));
  await copyFile(join(root, 'README.md'), join(dir, 'README.md'));

  const tarball = `phonecode-${t.name}.tar.gz`;
  // GNU tar (the release runs on Linux): record root as the owner, not the CI user.
  const owner = process.platform === 'linux' ? ['--owner=0', '--group=0', '--numeric-owner'] : [];
  await run(['tar', ...owner, '-czf', join(out, tarball), '-C', stage, `phonecode-${t.name}`], root);
  const hash = new Bun.CryptoHasher('sha256')
    .update(await Bun.file(join(out, tarball)).bytes())
    .digest('hex');
  sums.push(`${hash}  ${tarball}`);

  // npm platform package: @phone-code/<os>-<arch>
  const npmDir = join(out, 'npm', t.name);
  await mkdir(join(npmDir, 'bin'), { recursive: true });
  await copyFile(binary, join(npmDir, 'bin', 'phonecode'));
  await chmod(join(npmDir, 'bin', 'phonecode'), 0o755);
  await copyFile(join(root, 'LICENSE'), join(npmDir, 'LICENSE'));
  await writeFile(
    join(npmDir, 'package.json'),
    `${JSON.stringify(
      {
        name: `@phone-code/${t.name}`,
        ...common,
        description: `The ${t.os} ${t.cpu} phonecode binary. Install phone-code instead.`,
        os: [t.os],
        cpu: [t.cpu],
        files: ['bin/phonecode'],
        preferUnplugged: true,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(npmDir, 'README.md'),
    `# @phone-code/${t.name}\n\nThe ${t.os} ${t.cpu} binary for [phone-code](https://github.com/SloanBDavis/phone-code). Do not install this directly: \`npx phone-code\` or \`bunx phone-code\` picks the right one.\n`,
  );
}
await rm(stage, { recursive: true, force: true });
await writeFile(join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`);

// npm launcher: phone-code
const launcherDir = join(out, 'npm', 'phone-code');
await mkdir(join(launcherDir, 'bin'), { recursive: true });
await copyFile(join(root, 'scripts', 'npm', 'launcher.cjs'), join(launcherDir, 'bin', 'phonecode.cjs'));
await chmod(join(launcherDir, 'bin', 'phonecode.cjs'), 0o755);
await copyFile(join(root, 'LICENSE'), join(launcherDir, 'LICENSE'));
await copyFile(join(root, 'README.md'), join(launcherDir, 'README.md'));
await writeFile(
  join(launcherDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'phone-code',
      ...common,
      description,
      keywords: ['claude-code', 'codex', 'terminal', 'mobile', 'pwa', 'remote'],
      bin: { 'phone-code': 'bin/phonecode.cjs', phonecode: 'bin/phonecode.cjs' },
      files: ['bin/phonecode.cjs'],
      engines: { node: '>=18' },
      // Every target, even when --targets built fewer: the launcher must list them all.
      optionalDependencies: Object.fromEntries(ALL.map((t) => [`@phone-code/${t.name}`, version])),
    },
    null,
    2,
  )}\n`,
);

if (!has('no-pack') && Bun.which('npm') !== null) {
  for (const dir of [...targets.map((t) => t.name), 'phone-code']) {
    await run(['npm', 'pack', '--silent', '--pack-destination', join(out, 'npm')], join(out, 'npm', dir));
  }
}

console.log(`\nrelease/ for phonecode v${version}:`);
for (const line of sums) console.log(`  ${line}`);
