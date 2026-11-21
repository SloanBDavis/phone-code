import { Marked, type Tokens } from 'marked';
import { escapeHtml } from '../../lib/ansi';

/**
 * Markdown -> HTML for assistant text (GFM). Loaded lazily with the first
 * chat. Raw HTML in the source is shown as text, never interpreted; links are
 * limited to http(s)/mailto and open outside the app.
 */

const marked = new Marked({ gfm: true, breaks: false });

marked.use({
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(text);
    },
    code({ text, lang }: Tokens.Code): string {
      const language = (lang ?? '').trim().split(/\s+/)[0] ?? '';
      const label = language || 'text';
      return `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(label)}</span><button type="button" class="code-copy" data-copy aria-label="Copy code">Copy</button></div><pre><code data-lang="${escapeHtml(language)}">${escapeHtml(text)}</code></pre></div>`;
    },
    link({ href, title, tokens }: Tokens.Link): string {
      const inner = this.parser.parseInline(tokens);
      if (!/^(https?:|mailto:)/i.test(href)) return inner;
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(href)}"${t} target="_blank" rel="noopener noreferrer">${inner}</a>`;
    },
    image({ href, text }: Tokens.Image): string {
      if (!/^https?:/i.test(href)) return escapeHtml(text);
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text || href)}</a>`;
    },
  },
});

export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false });
  return html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
}

// ------------------------------------------------------------ highlighting

type Hljs = typeof import('highlight.js/lib/core').default;
let hljs: Promise<Hljs> | null = null;

function loadHljs(): Promise<Hljs> {
  hljs ??= (async () => {
    const [core, ts, js, bash, json, py, css, xml, diff, yaml, go, rust, scss, md, sql, swift] = await Promise.all([
      import('highlight.js/lib/core'),
      import('highlight.js/lib/languages/typescript'),
      import('highlight.js/lib/languages/javascript'),
      import('highlight.js/lib/languages/bash'),
      import('highlight.js/lib/languages/json'),
      import('highlight.js/lib/languages/python'),
      import('highlight.js/lib/languages/css'),
      import('highlight.js/lib/languages/xml'),
      import('highlight.js/lib/languages/diff'),
      import('highlight.js/lib/languages/yaml'),
      import('highlight.js/lib/languages/go'),
      import('highlight.js/lib/languages/rust'),
      import('highlight.js/lib/languages/scss'),
      import('highlight.js/lib/languages/markdown'),
      import('highlight.js/lib/languages/sql'),
      import('highlight.js/lib/languages/swift'),
    ]);
    const h = core.default;
    const reg = (names: string[], lang: { default: Parameters<Hljs['registerLanguage']>[1] }): void => {
      const [first, ...aliases] = names;
      if (!first) return;
      h.registerLanguage(first, lang.default);
      if (aliases.length) h.registerAliases(aliases, { languageName: first });
    };
    reg(['typescript', 'ts', 'tsx', 'mts'], ts);
    reg(['javascript', 'js', 'jsx', 'mjs', 'cjs'], js);
    reg(['bash', 'sh', 'shell', 'zsh', 'console'], bash);
    reg(['json', 'jsonc'], json);
    reg(['python', 'py'], py);
    reg(['css'], css);
    reg(['xml', 'html', 'svg', 'vue'], xml);
    reg(['diff', 'patch'], diff);
    reg(['yaml', 'yml'], yaml);
    reg(['go', 'golang'], go);
    reg(['rust', 'rs'], rust);
    reg(['scss', 'sass'], scss);
    reg(['markdown', 'md'], md);
    reg(['sql'], sql);
    reg(['swift'], swift);
    return h;
  })();
  return hljs;
}

/** Highlights code blocks inside `root` that have not been highlighted yet. */
export async function highlightIn(root: HTMLElement): Promise<void> {
  const blocks = root.querySelectorAll<HTMLElement>('code[data-lang]:not([data-hl])');
  if (!blocks.length) return;
  const h = await loadHljs();
  for (const el of blocks) {
    if (!el.isConnected) continue;
    const lang = el.dataset.lang ?? '';
    el.dataset.hl = '1';
    if (!lang || !h.getLanguage(lang)) continue;
    el.innerHTML = h.highlight(el.textContent, { language: lang, ignoreIllegals: true }).value;
  }
}

export function highlightCode(code: string, lang: string): Promise<string | null> {
  return loadHljs().then((h) =>
    h.getLanguage(lang) ? h.highlight(code, { language: lang, ignoreIllegals: true }).value : null,
  );
}
