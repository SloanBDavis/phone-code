/** ANSI SGR -> escaped HTML spans. Other control sequences are dropped. */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

const CUBE = [0, 95, 135, 175, 215, 255];

function color256(n: number): string {
  if (n < 16) return `var(--ansi-${n})`;
  if (n < 232) {
    const i = n - 16;
    return `rgb(${CUBE[Math.floor(i / 36)]},${CUBE[Math.floor(i / 6) % 6]},${CUBE[i % 6]})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

function applySgr(style: Style, params: number[]): Style {
  let s: Style = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i] ?? 0;
    if (p === 0) {
      s = {};
    } else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 7) s.inverse = true;
    else if (p === 22) s.bold = s.dim = false;
    else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if (p === 27) s.inverse = false;
    else if (p >= 30 && p <= 37) s.fg = `var(--ansi-${p - 30})`;
    else if (p >= 90 && p <= 97) s.fg = `var(--ansi-${p - 90 + 8})`;
    else if (p >= 40 && p <= 47) s.bg = `var(--ansi-${p - 40})`;
    else if (p >= 100 && p <= 107) s.bg = `var(--ansi-${p - 100 + 8})`;
    else if (p === 39) delete s.fg;
    else if (p === 49) delete s.bg;
    else if (p === 38 || p === 48) {
      const mode = params[i + 1];
      let c: string | undefined;
      if (mode === 5) {
        c = color256(params[i + 2] ?? 0);
        i += 2;
      } else if (mode === 2) {
        c = `rgb(${params[i + 2] ?? 0},${params[i + 3] ?? 0},${params[i + 4] ?? 0})`;
        i += 4;
      }
      if (c) {
        if (p === 38) s.fg = c;
        else s.bg = c;
      }
    }
  }
  return s;
}

function open(s: Style): string {
  let fg = s.fg;
  let bg = s.bg;
  if (s.inverse) [fg, bg] = [bg ?? 'var(--term-bg)', fg ?? 'var(--term-fg)'];
  const css: string[] = [];
  if (fg) css.push(`color:${fg}`);
  if (bg) css.push(`background:${bg}`);
  if (s.bold) css.push('font-weight:600');
  if (s.dim) css.push('opacity:.6');
  if (s.italic) css.push('font-style:italic');
  if (s.underline) css.push('text-decoration:underline');
  return css.length ? `<span style="${css.join(';')}">` : '';
}

// CSI ... final byte, OSC ... BEL/ST, and single-char escapes.
// oxlint-disable-next-line no-control-regex -- matching ANSI escapes requires the ESC control character
const SEQ = /\x1b\[([0-9;?]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r(?!\n)/g;

export function ansiToHtml(input: string): string {
  let out = '';
  let style: Style = {};
  let openTag = '';
  let last = 0;
  const flush = (text: string): void => {
    if (!text) return;
    out += openTag ? `${openTag}${escapeHtml(text)}</span>` : escapeHtml(text);
  };
  for (const m of input.matchAll(SEQ)) {
    flush(input.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] === 'm') {
      const params = (m[1] ?? '').split(';').map((x) => (x === '' ? 0 : Number(x)));
      style = applySgr(style, params);
      openTag = open(style);
    }
  }
  flush(input.slice(last));
  return out;
}

export const hasAnsi = (s: string): boolean => s.includes('\x1b[');
