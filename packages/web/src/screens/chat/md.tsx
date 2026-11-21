import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { toast } from '../../ui/overlay';
import { copyText, haptic } from '../../lib/util';

type MdModule = typeof import('./markdown');
let mod: MdModule | null = null;
let loading: Promise<MdModule> | null = null;

function loadMd(): Promise<MdModule> {
  loading ??= import('./markdown').then((m) => {
    mod = m;
    return m;
  });
  return loading;
}

/** Ensures the markdown chunk is loaded; re-renders the caller when it arrives. */
function useMd(): MdModule | null {
  const [m, setM] = useState<MdModule | null>(mod);
  useEffect(() => {
    if (m) return;
    let alive = true;
    void loadMd().then((x) => {
      if (alive) setM(x);
    });
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

  const onClick = (e: MouseEvent): void => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy]');
    if (!btn) return;
    const code = btn.closest('.code-block')?.querySelector('code')?.textContent ?? '';
    void copyText(code).then((ok) => {
      if (!ok) return;
      haptic('success');
      btn.textContent = 'Copied';
      btn.classList.add('done');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('done');
      }, 1400);
      toast('Copied', 'check');
    });
  };

  if (html === null)
    return (
      <div class={`md ${streaming ? 'streaming' : ''}`} data-plain>
        {text.split(/\n{2,}/).map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
    );
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- delegated handler for the real <button>s rendered inside the markdown
    <div
      ref={ref}
      class={`md ${streaming ? 'streaming' : ''}`}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
