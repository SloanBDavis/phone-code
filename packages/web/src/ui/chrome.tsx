import type { ComponentChildren, JSX, RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { pop } from '../lib/nav';
import { GlassButton } from './glass';

/** Tracks whether a scroller has moved past `threshold`, at most once per frame. */
export function useScrolled<T extends HTMLElement>(threshold = 8): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    let frame = 0;
    const check = (): void => {
      frame = 0;
      setScrolled(el.scrollTop > threshold);
    };
    const onScroll = (): void => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    check();
    return () => {
      el.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [threshold]);
  return [ref, scrolled];
}

export function BackButton({ label = 'Back' }: { label?: string }): JSX.Element {
  return <GlassButton icon="back" label={label} iconSize={22} onClick={() => pop()} testid="nav-back" />;
}

/** Floating glass controls over content, with the scroll-edge fade beneath them. */
export function TopBar({
  left,
  right,
  title,
  subtitle,
  showTitle = true,
  fade = true,
  titleSlot,
}: {
  left?: ComponentChildren;
  right?: ComponentChildren;
  title?: string;
  subtitle?: ComponentChildren;
  showTitle?: boolean;
  fade?: boolean;
  /** Replaces the plain title (e.g. a tappable title capsule). */
  titleSlot?: ComponentChildren;
}): JSX.Element {
  return (
    <>
      <div class={`edge-fade ${fade ? 'show' : ''}`} aria-hidden="true" />
      <div class="topbar">
        {left}
        {titleSlot ?? (
          <div class={`topbar-title ${showTitle ? 'show' : ''}`} aria-hidden={!showTitle}>
            <span>{title}</span>
            {subtitle && <small>{subtitle}</small>}
          </div>
        )}
        <div class="spacer" />
        {right}
      </div>
    </>
  );
}
