import type { ChatItem, FsListResult, HostInfo, ResumableSession, SessionInfo } from '@phone-code/protocol';

/** Scripted content for the in-browser demo host. */

export const HOME = '/Users/maya';
const MIN = 60_000;

export const demoHost: HostInfo = {
  name: 'studio',
  platform: 'darwin',
  user: 'maya',
  home: HOME,
  daemonVersion: '0.1.0',
  shell: '/bin/zsh',
  agents: [
    { kind: 'claude', available: true, version: '2.1.4', models: ['opus', 'sonnet', 'haiku'] },
    { kind: 'codex', available: true, version: '0.58.0', models: ['gpt-5-codex', 'gpt-5', 'gpt-5-mini'] },
  ],
};

let idn = 0;
const id = (p: string): string => `${p}-${(idn++).toString(36)}`;

export interface DemoSession {
  info: SessionInfo;
  items: ChatItem[];
}

function s(
  info: Omit<SessionInfo, 'createdAt'> & { createdAt?: number },
  items: ChatItem[] = [],
): DemoSession {
  return { info: { createdAt: info.updatedAt - 20 * MIN, ...info }, items };
}

export function buildDemo(now = Date.now()): DemoSession[] {
  const ago = (m: number): number => now - m * MIN;

  const authItems: ChatItem[] = [
    {
      id: id('u'),
      ts: ago(6),
      kind: 'user',
      text: 'The auth refresh test fails maybe 1 in 5 runs on CI. Can you find out why and fix it?',
    },
    {
      id: id('th'),
      ts: ago(6),
      kind: 'thinking',
      streaming: false,
      text: 'Intermittent failures in a refresh test usually mean timing. I should look at how the test builds its session and how `refreshSession` compares `expiresAt` against the clock. If the fixture sets expiry to "now + 0", a slow CI runner crosses the boundary between creating the fixture and calling refresh.',
    },
    {
      id: id('t'),
      ts: ago(6),
      kind: 'text',
      streaming: false,
      text: "I'll start by looking at the failing test and the code it exercises.",
    },
    {
      id: id('tool'),
      ts: ago(6),
      kind: 'tool',
      name: 'Read',
      title: 'test/auth/refresh.test.ts',
      status: 'done',
      detail: { type: 'file', path: 'test/auth/refresh.test.ts' },
      output: '48 lines',
    },
    {
      id: id('tool'),
      ts: ago(5),
      kind: 'tool',
      name: 'Grep',
      title: 'expiresAt',
      status: 'done',
      detail: { type: 'search', query: 'expiresAt', path: 'src/' },
      output:
        'src/auth/session.ts:14:  if (session.expiresAt < Date.now()) {\nsrc/auth/store.ts:31:    expiresAt: Date.now() + ttlMs,\nsrc/auth/types.ts:6:  expiresAt: number;',
    },
    {
      id: id('t'),
      ts: ago(5),
      kind: 'text',
      streaming: false,
      text: 'Found it. The fixture creates a session with `ttlMs: 0`, and `refreshSession` treats a session as expired when `expiresAt < Date.now()`. On a slow runner a millisecond passes between the two calls, so the check flips.\n\nThe fix is to allow a small clock skew instead of a strict comparison:',
    },
    {
      id: id('tool'),
      ts: ago(4),
      kind: 'tool',
      name: 'Edit',
      title: 'src/auth/session.ts',
      status: 'done',
      detail: {
        type: 'diff',
        path: 'src/auth/session.ts',
        added: 4,
        removed: 2,
        patch: [
          '@@ -10,9 +10,11 @@ export async function refreshSession(token: string) {',
          '   const session = await store.get(token);',
          '   if (!session) throw new SessionNotFound();',
          '-  if (session.expiresAt < Date.now()) {',
          '-    throw new SessionExpired();',
          '+  // Allow 30s of clock skew between the API and its clients.',
          '+  const skewMs = 30_000;',
          '+  if (session.expiresAt + skewMs < Date.now()) {',
          '+    throw new SessionExpired(session.id);',
          '   }',
          '   return rotate(session);',
          ' }',
        ].join('\n'),
      },
    },
    {
      id: id('t'),
      ts: ago(3),
      kind: 'text',
      streaming: false,
      text: "Now I'd like to run the auth suite a few times in a row to confirm it's stable.",
    },
    {
      id: 'perm-auth',
      ts: ago(1),
      kind: 'permission',
      toolName: 'Bash',
      title: 'npm test -- --repeat 20 auth',
      status: 'pending',
      canAllowAlways: true,
      detail: { type: 'command', command: 'npm test -- --repeat 20 auth', cwd: '~/code/acme-api' },
    },
  ];

  const billingItems: ChatItem[] = [
    {
      id: id('u'),
      ts: ago(14),
      kind: 'user',
      text: 'Split src/billing/invoice.ts into smaller modules. Keep the public API the same.',
    },
    {
      id: id('t'),
      ts: ago(14),
      kind: 'text',
      streaming: false,
      text: "Here's the plan. I'll keep `index.ts` re-exporting everything so callers don't change.",
    },
    {
      id: 'todo-billing',
      ts: ago(13),
      kind: 'tool',
      name: 'Todo',
      title: 'Update plan',
      status: 'done',
      detail: {
        type: 'todos',
        todos: [
          { text: 'Map the public exports of invoice.ts', status: 'completed' },
          { text: 'Move tax math into tax.ts', status: 'completed' },
          { text: 'Move PDF rendering into render.ts', status: 'in_progress' },
          { text: 'Re-export from billing/index.ts', status: 'pending' },
          { text: 'Run typecheck and billing tests', status: 'pending' },
        ],
      },
    },
    {
      id: id('tool'),
      ts: ago(12),
      kind: 'tool',
      name: 'Bash',
      title: 'rg -n "export" src/billing/invoice.ts',
      status: 'done',
      detail: { type: 'command', command: 'rg -n "export" src/billing/invoice.ts', exitCode: 0 },
      output:
        '\x1b[32m12\x1b[0m:export interface Invoice {\n\x1b[32m40\x1b[0m:export function computeTax(lines: Line[], region: Region) {\n\x1b[32m88\x1b[0m:export function totals(inv: Invoice) {\n\x1b[32m131\x1b[0m:export async function renderPdf(inv: Invoice) {',
    },
    {
      id: id('tool'),
      ts: ago(11),
      kind: 'tool',
      name: 'Write',
      title: 'src/billing/tax.ts',
      status: 'done',
      detail: {
        type: 'diff',
        path: 'src/billing/tax.ts',
        added: 9,
        removed: 0,
        patch: [
          '@@ -0,0 +1,9 @@',
          "+import type { Line, Region } from './types';",
          "+import { RATES } from './rates';",
          '+',
          '+export function computeTax(lines: Line[], region: Region): number {',
          '+  const rate = RATES[region] ?? 0;',
          '+  return lines.reduce((sum, l) => sum + l.amount * rate, 0);',
          '+}',
          '+',
          "+export { RATES } from './rates';",
        ].join('\n'),
      },
    },
    {
      id: id('tool'),
      ts: ago(9),
      kind: 'tool',
      name: 'Edit',
      title: 'src/billing/invoice.ts',
      status: 'done',
      detail: {
        type: 'diff',
        path: 'src/billing/invoice.ts',
        added: 1,
        removed: 6,
        patch: [
          '@@ -38,12 +38,7 @@ export interface Invoice {',
          ' }',
          ' ',
          '-export function computeTax(lines: Line[], region: Region) {',
          '-  const rate = RATES[region] ?? 0;',
          '-  return lines.reduce((sum, l) => sum + l.amount * rate, 0);',
          '-}',
          '-',
          '-const RATES = loadRates();',
          "+export { computeTax } from './tax';",
          ' ',
          ' export function totals(inv: Invoice) {',
        ].join('\n'),
      },
    },
    {
      id: id('t'),
      ts: ago(2),
      kind: 'text',
      streaming: false,
      text: 'Tax math is out. Moving the PDF renderer next.',
    },
  ];

  const chartItems: ChatItem[] = [
    {
      id: id('u'),
      ts: ago(32),
      kind: 'user',
      text: 'Add a revenue chart to the dashboard home page.',
    },
    {
      id: id('t'),
      ts: ago(31),
      kind: 'text',
      streaming: false,
      text: "The dashboard doesn't have a charting library yet. Before I add one, a quick question:",
    },
    {
      id: 'q-chart',
      ts: ago(31),
      kind: 'question',
      status: 'pending',
      questions: [
        {
          header: 'Library',
          question: 'Which charting library should I use?',
          options: [
            { label: 'uPlot', description: 'Tiny and very fast, canvas based. Fewer built-in chart types.' },
            { label: 'Recharts', description: 'React components, SVG, easy to style. Heavier bundle.' },
            { label: 'Hand-rolled SVG', description: 'No dependency. Fine for one simple line chart.' },
          ],
        },
      ],
    },
  ];

  const viteItems: ChatItem[] = [
    { id: id('u'), ts: ago(190), kind: 'user', text: 'Migrate the site from Vite 4 to Vite 6.' },
    {
      id: id('th'),
      ts: ago(190),
      kind: 'thinking',
      streaming: false,
      text: 'Vite 6 changes the default `resolve.conditions`, drops Node 16 and moves the Sass API default to modern. I should check the plugins first since some of them pin a Vite peer range.',
    },
    {
      id: 'task-1',
      ts: ago(189),
      kind: 'tool',
      name: 'Task',
      title: 'Audit plugins for Vite 6 compatibility',
      status: 'done',
      input: {
        description: 'Audit plugins',
        prompt: 'Check every Vite plugin in package.json for Vite 6 support.',
      },
      output:
        'All four plugins support Vite 6. `vite-plugin-svgr` needs ^4.3. `@vitejs/plugin-legacy` can be removed: the browserslist no longer includes legacy targets.',
    },
    {
      id: id('tool'),
      ts: ago(189),
      kind: 'tool',
      name: 'Read',
      title: 'package.json',
      status: 'done',
      parentId: 'task-1',
      detail: { type: 'file', path: 'package.json' },
    },
    {
      id: id('tool'),
      ts: ago(189),
      kind: 'tool',
      name: 'WebFetch',
      title: 'vite.dev/guide/migration',
      status: 'done',
      parentId: 'task-1',
      detail: { type: 'url', url: 'https://vite.dev/guide/migration' },
    },
    {
      id: id('tool'),
      ts: ago(189),
      kind: 'tool',
      name: 'Bash',
      title: 'npm view vite-plugin-svgr peerDependencies',
      status: 'done',
      parentId: 'task-1',
      detail: { type: 'command', command: 'npm view vite-plugin-svgr peerDependencies', exitCode: 0 },
      output: "{ vite: '>=2.6.0' }",
    },
    {
      id: id('tool'),
      ts: ago(188),
      kind: 'tool',
      name: 'Bash',
      title: 'npm install vite@6 vite-plugin-svgr@^4.3',
      status: 'done',
      detail: { type: 'command', command: 'npm install vite@6 vite-plugin-svgr@^4.3', exitCode: 0 },
      output:
        '\nadded 3 packages, changed 11 packages in 4s\n\n\x1b[1m42\x1b[22m packages are looking for funding\n',
    },
    {
      id: id('tool'),
      ts: ago(187),
      kind: 'tool',
      name: 'Edit',
      title: 'vite.config.ts',
      status: 'done',
      detail: {
        type: 'diff',
        path: 'vite.config.ts',
        added: 2,
        removed: 3,
        patch: [
          '@@ -1,12 +1,11 @@',
          " import { defineConfig } from 'vite';",
          "-import legacy from '@vitejs/plugin-legacy';",
          " import svgr from 'vite-plugin-svgr';",
          ' ',
          ' export default defineConfig({',
          '-  plugins: [svgr(), legacy({ targets: ["defaults"] })],',
          '+  plugins: [svgr()],',
          '   css: {',
          "-    preprocessorOptions: { scss: { api: 'legacy' } },",
          "+    preprocessorOptions: { scss: { api: 'modern-compiler' } },",
          '   },',
          ' });',
        ].join('\n'),
      },
    },
    {
      id: id('tool'),
      ts: ago(186),
      kind: 'tool',
      name: 'Bash',
      title: 'npm run build',
      status: 'done',
      detail: { type: 'command', command: 'npm run build', exitCode: 0 },
      output:
        '\x1b[36mvite v6.0.3 \x1b[32mbuilding for production...\x1b[0m\n\x1b[32m✓\x1b[0m 412 modules transformed.\n\x1b[2mdist/\x1b[22m\x1b[32mindex.html                 \x1b[0m\x1b[1m\x1b[2m  0.62 kB\x1b[22m\n\x1b[2mdist/\x1b[22m\x1b[35massets/index-4f1c2a.css     \x1b[0m\x1b[1m\x1b[2m 18.40 kB\x1b[22m\n\x1b[2mdist/\x1b[22m\x1b[36massets/index-b81d9e.js      \x1b[0m\x1b[1m\x1b[2m142.07 kB\x1b[22m\n\x1b[32m✓ built in 2.81s\x1b[0m',
    },
    {
      id: id('tool'),
      ts: ago(186),
      kind: 'tool',
      name: 'Todo',
      title: 'Update plan',
      status: 'done',
      detail: {
        type: 'todos',
        todos: [
          { text: 'Audit plugins', status: 'completed' },
          { text: 'Upgrade vite and svgr', status: 'completed' },
          { text: 'Drop plugin-legacy', status: 'completed' },
          { text: 'Switch Sass to the modern compiler', status: 'completed' },
          { text: 'Build and smoke test', status: 'completed' },
        ],
      },
    },
    {
      id: id('t'),
      ts: ago(185),
      kind: 'text',
      streaming: false,
      text: [
        'The site now builds on **Vite 6**. Summary of the changes:',
        '',
        '| Package | Before | After |',
        '| --- | --- | --- |',
        '| `vite` | 4.5.3 | 6.0.3 |',
        '| `vite-plugin-svgr` | 3.2.0 | 4.3.0 |',
        '| `@vitejs/plugin-legacy` | 4.1.1 | removed |',
        '| Sass API | legacy | modern-compiler |',
        '',
        'Two things worth knowing:',
        '',
        '1. `plugin-legacy` is gone because your `browserslist` already excludes browsers without native ESM.',
        '2. Sass now uses the modern compiler, which is about 2x faster. If you see `@import` deprecation warnings, the fix is to switch to `@use`:',
        '',
        '```scss',
        '// before',
        "@import 'tokens';",
        '',
        '// after',
        "@use 'tokens' as *;",
        '```',
        '',
        'Build output is 4% smaller than before. You can verify with:',
        '',
        '```bash',
        'npm run build && npx vite preview --port 4173',
        '```',
      ].join('\n'),
    },
    {
      id: id('turn'),
      ts: ago(185),
      kind: 'turn',
      outcome: 'completed',
      durationMs: 272_000,
      costUsd: 0.41,
      inputTokens: 48_211,
      outputTokens: 5_904,
    },
  ];

  const notesItems: ChatItem[] = [
    { id: id('u'), ts: ago(2900), kind: 'user', text: 'Write release notes for v2.3 from the merged PRs.' },
    {
      id: id('tool'),
      ts: ago(2900),
      kind: 'tool',
      name: 'Bash',
      title: 'gh pr list --state merged --limit 30',
      status: 'done',
      detail: { type: 'command', command: 'gh pr list --state merged --limit 30', exitCode: 0 },
      output: '#412  Faster cold start\n#409  Offline drafts\n#405  Fix crash on empty workspace',
    },
    {
      id: id('t'),
      ts: ago(2899),
      kind: 'text',
      streaming: false,
      text: '## v2.3\n\n- **Faster cold start.** The app shell is cached, so launch is instant.\n- **Offline drafts.** Messages you type offline are kept and sent when you reconnect.\n- Fixed a crash when opening an empty workspace.',
    },
    { id: id('turn'), ts: ago(2899), kind: 'turn', outcome: 'completed', durationMs: 41_000, costUsd: 0.06 },
  ];

  return [
    s(
      {
        id: 'demo-auth',
        kind: 'agent',
        agent: 'claude',
        title: 'Fix flaky auth test',
        cwd: `${HOME}/code/acme-api`,
        updatedAt: ago(1),
        status: 'waiting',
        preview: 'Wants to run npm test -- --repeat 20 auth',
        model: 'opus',
        permissionMode: 'default',
        unread: true,
      },
      authItems,
    ),
    s(
      {
        id: 'demo-billing',
        kind: 'agent',
        agent: 'codex',
        title: 'Refactor billing module',
        cwd: `${HOME}/code/acme-api`,
        updatedAt: ago(0.2),
        status: 'running',
        preview: 'Tax math is out. Moving the PDF renderer next.',
        model: 'gpt-5-codex',
        permissionMode: 'acceptEdits',
      },
      billingItems,
    ),
    s(
      {
        id: 'demo-chart',
        kind: 'agent',
        agent: 'claude',
        title: 'Revenue chart on dashboard',
        cwd: `${HOME}/code/dashboard`,
        updatedAt: ago(31),
        status: 'waiting',
        preview: 'Which charting library should I use?',
        model: 'sonnet',
        permissionMode: 'default',
      },
      chartItems,
    ),
    s({
      id: 'demo-shell',
      kind: 'terminal',
      title: 'zsh',
      cwd: `${HOME}/code/phone-code`,
      updatedAt: ago(48),
      status: 'idle',
      preview: 'git status',
    }),
    s(
      {
        id: 'demo-vite',
        kind: 'agent',
        agent: 'claude',
        title: 'Migrate to Vite 6',
        cwd: `${HOME}/code/site`,
        updatedAt: ago(185),
        status: 'idle',
        preview: 'The site now builds on Vite 6.',
        model: 'opus',
        permissionMode: 'acceptEdits',
      },
      viteItems,
    ),
    s({
      id: 'demo-dev',
      kind: 'terminal',
      title: 'dev server',
      cwd: `${HOME}/code/dashboard`,
      updatedAt: ago(1500),
      status: 'exited',
      preview: 'npm run dev',
    }),
    s(
      {
        id: 'demo-notes',
        kind: 'agent',
        agent: 'codex',
        title: 'Release notes for v2.3',
        cwd: `${HOME}/code/app`,
        updatedAt: ago(2899),
        status: 'idle',
        preview: 'v2.3: faster cold start, offline drafts.',
        model: 'gpt-5',
        permissionMode: 'default',
      },
      notesItems,
    ),
  ];
}

// ------------------------------------------------------------------ fs

const TREE: Record<string, string[]> = {
  [HOME]: ['code/', 'Desktop/', 'Documents/', 'Downloads/', '.config/', '.ssh/', 'notes.md'],
  [`${HOME}/code`]: ['acme-api/', 'app/', 'dashboard/', 'phone-code/', 'site/', 'dotfiles/'],
  [`${HOME}/code/acme-api`]: ['src/', 'test/', '.git/', 'package.json', 'README.md'],
  [`${HOME}/code/phone-code`]: ['packages/', 'e2e/', '.git/', 'package.json', 'README.md', 'LICENSE'],
  [`${HOME}/code/phone-code/packages`]: ['daemon/', 'protocol/', 'web/'],
  [`${HOME}/code/dashboard`]: ['src/', 'public/', '.git/', 'package.json'],
  [`${HOME}/code/site`]: ['src/', 'content/', '.git/', 'vite.config.ts'],
  [`${HOME}/Documents`]: ['Invoices/', 'Talks/'],
};

export function fsList(path?: string): FsListResult {
  const p = (path ?? HOME).replace(/^~/, HOME).replace(/\/+$/, '') || '/';
  const names = TREE[p] ?? ['src/', 'docs/', 'README.md'];
  const parent = p === '/' ? undefined : p.slice(0, p.lastIndexOf('/')) || '/';
  return {
    path: p,
    ...(parent ? { parent } : {}),
    entries: names.map((n) => ({
      name: n.replace(/\/$/, ''),
      dir: n.endsWith('/'),
      hidden: n.startsWith('.'),
    })),
  };
}

export function history(now = Date.now()): ResumableSession[] {
  return [
    {
      agent: 'claude',
      resumeId: 'h1',
      cwd: `${HOME}/code/acme-api`,
      title: 'Add rate limiting to the public API',
      updatedAt: now - 26 * 60 * MIN,
      messageCount: 38,
    },
    {
      agent: 'claude',
      resumeId: 'h2',
      cwd: `${HOME}/code/site`,
      title: 'Why is the hero image blurry on retina?',
      updatedAt: now - 3 * 1440 * MIN,
      messageCount: 12,
    },
    {
      agent: 'codex',
      resumeId: 'h3',
      cwd: `${HOME}/code/app`,
      title: 'Port the settings screen to the new router',
      updatedAt: now - 4 * 1440 * MIN,
      messageCount: 21,
    },
    {
      agent: 'claude',
      resumeId: 'h4',
      cwd: `${HOME}/code/dotfiles`,
      title: 'Clean up my zsh startup time',
      updatedAt: now - 9 * 1440 * MIN,
      messageCount: 7,
    },
  ];
}

/**
 * A synthetic long transcript (`?demo=1&demoItems=2000`) for checking scroll
 * and streaming performance on real phones.
 */
export function longSession(count: number, now = Date.now()): DemoSession {
  const items: ChatItem[] = [];
  for (let i = 0; i < count; i++) {
    const ts = now - (count - i) * 30_000;
    const k = i % 5;
    if (k === 0)
      items.push({ id: `L${i}`, ts, kind: 'user', text: `Step ${i / 5 + 1}: keep going with the refactor.` });
    else if (k === 1)
      items.push({
        id: `L${i}`,
        ts,
        kind: 'text',
        streaming: false,
        text: `Working on **part ${i}**. Updated \`src/mod${i}.ts\` and checked the callers:\n\n- renamed the export\n- fixed two imports\n\n\`\`\`ts\nexport const value${i} = compute(${i});\n\`\`\``,
      });
    else if (k === 4)
      items.push({ id: `L${i}`, ts, kind: 'turn', outcome: 'completed', durationMs: 12_000, costUsd: 0.02 });
    else
      items.push({
        id: `L${i}`,
        ts,
        kind: 'tool',
        name: k === 2 ? 'Bash' : 'Edit',
        title: k === 2 ? `npm test -- mod${i}` : `src/mod${i}.ts`,
        status: 'done',
        detail:
          k === 2
            ? { type: 'command', command: `npm test -- mod${i}`, exitCode: 0 }
            : {
                type: 'diff',
                path: `src/mod${i}.ts`,
                added: 1,
                removed: 1,
                patch: `@@ -1,1 +1,1 @@\n-old${i}\n+new${i}`,
              },
        output: k === 2 ? '\x1b[32m✓\x1b[0m 12 passed' : undefined,
      });
  }
  return s(
    {
      id: 'demo-long',
      kind: 'agent',
      agent: 'claude',
      title: `Long session (${count} items)`,
      cwd: `${HOME}/code/app`,
      updatedAt: now - 5 * MIN,
      status: 'idle',
      preview: 'A very long transcript',
      model: 'opus',
      permissionMode: 'default',
    },
    items,
  );
}
