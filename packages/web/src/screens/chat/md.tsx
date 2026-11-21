import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { toast } from '../../ui/overlay';
import { copyText, haptic } from '../../lib/util';
import type * as Md from './markdown';

type MdModule = typeof Md;
let mod: MdModule | null = null;
let loading: Promise<MdModule> | null = null;

function loadMd(): Promise<MdModule> {
  loading ??= (async () => {
    mod = await import('./markdown');
    return mod;
  })();
  return loading;
}

async function copyCode(btn: HTMLButtonElement): Promise<void> {
  const code = btn.closest('.code-block')?.querySelector('code')?.textContent ?? '';
  if (!(await copyText(code))) return;
  haptic('success');
  btn.textContent = 'Copied';
  btn.classList.add('done');
  setTimeout(() => {
    btn.textContent = 'Copy';
    btn.classList.remove('done');
  }, 1400);
  toast('Copied', 'check');
}

function onMdClick(e: MouseEvent): void {
  const t = e.target;
  const btn = t instanceof Element ? t.closest<HTMLButtonElement>('[data-copy]') : null;
  if (btn) void copyCode(btn);
}

/** Ensures the markdown chunk is loaded; re-renders the caller when it arrives. */
function useMd(): MdModule | null {
  const [m, setM] = useState<MdModule | null>(mod);
  useEffect(() => {
    if (m) return undefined;
    let alive = true;
    const run = async (): Promise<void> => {
      const x = await loadMd();
      if (alive) setM(x);
    };
    void run();
    return () => {
      alive = false;
    };
  }, [m]);
  return m;
}

export function Markdown({ text, streaming }: { text: string; streaming?: boolean }): JSX.Element {
  const md = useMd();
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => (md ? md.renderMarkdown(text) : null), [md, text]);

  useEffect(() => {
    if (!md || streaming || !ref.current) return;
    void md.highlightIn(ref.current);
  }, [md, html, streaming]);

  if (html === null)
    return (
      <div class={`md ${streaming ? 'streaming' : ''}`} data-plain>
        {text.split(/\n{2,}/).map((p, i) => (
          // Paragraph order is stable while streaming; text is not a unique key.
          // oxlint-disable-next-line react/no-array-index-key -- positional paragraphs of one text
          <p key={i}>{p}</p>
        ))}
      </div>
    );
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- delegated handler for the real <button>s rendered inside the markdown
    <div
      ref={ref}
      class={`md ${streaming ? 'streaming' : ''}`}
      onClick={onMdClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
