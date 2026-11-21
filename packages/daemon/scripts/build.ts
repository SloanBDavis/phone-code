/**
 * Build the self-contained `dist/phonecode` executable:
 *  1. stage packages/web/dist into dist/web, with brotli-precompressed siblings
 *  2. `bun build --compile` the CLI and the screen worker, embedding dist/web
 *
 * Usage: bun scripts/build.ts [--target=bun-darwin-arm64|bun-linux-x64|...] [--outfile=path]
 *
 * scripts/build-release.ts at the repo root calls this once per release target.
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';

const root = join(import.meta.dir, '..');
const webSrc = process.env['PHONECODE_WEB_DIST'] ?? join(root, '..', 'web', 'dist');
const webOut = join(root, 'dist', 'web');
const COMPRESSIBLE = /\.(?:html|js|mjs|css|json|webmanifest|svg|txt|map|wasm|xml)$/;

async function stageWeb(): Promise<boolean> {
  await rm(webOut, { recursive: true, force: true });
  if (!existsSync(join(webSrc, 'index.html'))) {
    console.warn(`! ${webSrc} has no index.html: building without the web app (placeholder page)`);
    return false;
  }
  await cp(webSrc, webOut, { recursive: true });
  const files = await readdir(webOut, { recursive: true });
  let raw = 0;
  let packed = 0;
  await Promise.all(
    files.map(async (name) => {
      const path = join(webOut, name);
      const info = await stat(path);
      if (!info.isFile() || name.endsWith('.br') || name.endsWith('.gz')) return;
      raw += info.size;
      if (!COMPRESSIBLE.test(name) || info.size < 512) {
        packed += info.size;
        return;
      }
      const data = await Bun.file(path).bytes();
      const br = brotliCompressSync(data, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length },
      });
      if (br.length < data.length * 0.9) {
        await Bun.write(`${path}.br`, br);
        packed += br.length;
      } else {
        packed += info.size;
      }
    }),
  );
  console.log(
    `staged web app: ${(raw / 1024).toFixed(0)} kB, ${(packed / 1024).toFixed(0)} kB as served with brotli`,
  );
  return true;
}

const TARGETS = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-darwin-x64-baseline',
  'bun-linux-x64',
  'bun-linux-x64-baseline',
  'bun-linux-arm64',
  'bun-linux-x64-musl',
  'bun-linux-arm64-musl',
] as const satisfies readonly Bun.Build.CompileTarget[];
type Target = (typeof TARGETS)[number];
const isTarget = (v: string | undefined): v is Target => TARGETS.some((t) => t === v);
const rawTarget = process.argv.find((a) => a.startsWith('--target='))?.slice('--target='.length);
if (rawTarget !== undefined && !isTarget(rawTarget)) {
  console.error(`unknown --target ${rawTarget}; one of ${TARGETS.join(', ')}`);
  process.exit(1);
}
const targetArg = isTarget(rawTarget) ? rawTarget : undefined;
const outArg = process.argv.find((a) => a.startsWith('--outfile='))?.slice('--outfile='.length);
const outfile = outArg === undefined ? join(root, 'dist', 'phonecode') : resolve(outArg);
const hasWeb = await stageWeb();
await mkdir(dirname(outfile), { recursive: true });
process.chdir(root);

const result = await Bun.build({
  entrypoints: ['./src/cli.ts', './src/screen-worker.ts'],
  minify: true,
  sourcemap: 'none',
  bytecode: true,
  compile: {
    outfile,
    ...(targetArg === undefined ? {} : { target: targetArg }),
    ...(hasWeb ? { assets: ['./dist/web'] } : {}),
  },
});
if (!result.success) {
  for (const entry of result.logs) console.error(entry);
  process.exit(1);
}
const size = (await stat(outfile)).size;
const label = `${relative(process.cwd(), outfile)}${targetArg === undefined ? '' : ` for ${targetArg}`}`;
console.log(`built ${label} (${(size / 1024 / 1024).toFixed(1)} MB)`);
