#!/usr/bin/env bun
/**
 * Keep docs/protocol.md in sync with packages/protocol/src/index.ts.
 *
 * The prose in docs/protocol.md is written by hand. Everything between the
 * GENERATED markers is rebuilt from the protocol source: the message tables
 * (from the ClientMessage / ServerMessage unions) and the full type listing.
 *
 * Usage: bun scripts/protocol-doc.ts           rewrite docs/protocol.md
 *        bun scripts/protocol-doc.ts --check   exit 1 if it is out of date
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const srcPath = join(root, 'packages', 'protocol', 'src', 'index.ts');
const docPath = join(root, 'docs', 'protocol.md');
const BEGIN = '<!-- BEGIN GENERATED: bun scripts/protocol-doc.ts -->';
const END = '<!-- END GENERATED -->';

const src = await readFile(srcPath, 'utf8');

interface Message {
  t: string;
  fields: string;
  note: string;
}

/** The members of `export type <name> = | {...} | {...};`, each with the doc comment above it. */
function unionMembers(name: string): Message[] {
  const start = src.indexOf(`export type ${name} =`);
  if (start < 0) throw new Error(`${name} not found in ${srcPath}`);
  const body = src.slice(start, src.indexOf(';\n\n', start) + 1);
  const out: Message[] = [];
  let pending = '';
  for (const part of body.split(/\n\s*\|\s*/).slice(1)) {
    // The member object is the first balanced {...}; anything after it is a
    // comment that belongs to the next member.
    let depth = 0;
    let close = -1;
    for (let i = 0; i < part.length && close < 0; i++) {
      if (part[i] === '{') depth++;
      else if (part[i] === '}' && --depth === 0) close = i;
    }
    const obj = part.slice(1, close);
    const t = /t:\s*'([^']+)'/.exec(obj)?.[1];
    const note = pending;
    pending =
      /\/\*\*([\s\S]*?)\*\//
        .exec(part.slice(close + 1))?.[1]
        ?.replace(/\s*\n\s*\*?\s*/g, ' ')
        .trim() ?? '';
    if (t === undefined) continue;
    const fields = obj
      .split(/;|\n/)
      .map((f) => f.trim())
      .filter((f) => f !== '' && !f.startsWith('t:'))
      .join('; ');
    const prev = out.at(-1);
    // The two `res` members (ok: true / ok: false) read better as one row.
    if (prev?.t === t) {
      prev.fields = `${prev.fields} **or** ${fields}`;
      continue;
    }
    out.push({ t, fields, note });
  }
  return out;
}

const esc = (s: string): string => s.replaceAll('|', '\\|');
function table(rows: Message[]): string {
  const lines = ['| `t` | Fields | Notes |', '| --- | --- | --- |'];
  for (const r of rows) {
    const fields = r.fields === '' ? '' : `\`${esc(r.fields).replaceAll(' **or** ', '` or `')}\``;
    lines.push(`| \`${r.t}\` | ${fields} | ${esc(r.note)} |`);
  }
  return lines.join('\n');
}

const version = /export const PROTOCOL_VERSION = (\d+);/.exec(src)?.[1];
if (version === undefined) throw new Error('PROTOCOL_VERSION not found');

const generated = [
  BEGIN,
  '',
  `Protocol version: **${version}** (\`PROTOCOL_VERSION\`).`,
  '',
  '### Client to daemon (`ClientMessage`)',
  '',
  table(unionMembers('ClientMessage')),
  '',
  '### Daemon to client (`ServerMessage`)',
  '',
  table(unionMembers('ServerMessage')),
  '',
  '### Full type listing',
  '',
  'Verbatim from `packages/protocol/src/index.ts`:',
  '',
  '```ts',
  src.trimEnd(),
  '```',
  '',
  END,
].join('\n');

const doc = await readFile(docPath, 'utf8');
const a = doc.indexOf(BEGIN);
const b = doc.indexOf(END);
if (a < 0 || b < a) throw new Error(`${docPath} has no GENERATED markers`);
const next = await format(`${doc.slice(0, a)}${generated}${doc.slice(b + END.length)}`);

/** Run the result through oxfmt, so `bun run format:check` agrees with this script. */
async function format(text: string): Promise<string> {
  const proc = Bun.spawn([join(root, 'node_modules', '.bin', 'oxfmt'), '--stdin-filepath=docs/protocol.md'], {
    cwd: root,
    stdin: new Blob([text]),
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error('oxfmt failed on docs/protocol.md');
  return out;
}

if (process.argv.includes('--check')) {
  if (next !== doc) {
    console.error('docs/protocol.md is out of date with packages/protocol/src/index.ts.');
    console.error('Run: bun run docs:protocol');
    process.exit(1);
  }
} else if (next !== doc) {
  await writeFile(docPath, next);
  console.log('updated docs/protocol.md');
}
