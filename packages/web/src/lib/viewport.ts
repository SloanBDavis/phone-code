import { signal } from '@preact/signals';

/** True while the on-screen keyboard is up (visual viewport much shorter than layout). */
export const keyboardOpen = signal(false);

/**
 * Pins the app shell to the visual viewport. On iOS the keyboard does not
 * resize the layout viewport; it shrinks the visual viewport and may scroll
 * it. Sizing the fixed shell to `visualViewport` puts the composer and the
 * terminal key bar exactly on top of the keyboard. Updates are coalesced into
 * one write per frame and only touch two custom properties.
 */
export function trackViewport(root: HTMLElement): void {
  const vv = window.visualViewport;
  let frame = 0;
  let lastH = -1;
  let lastTop = -1;
  const apply = (): void => {
    frame = 0;
    const h = Math.round(vv ? vv.height : innerHeight);
    const top = Math.round(vv ? vv.offsetTop : 0);
    if (h !== lastH) {
      root.style.setProperty('--app-h', `${h}px`);
      lastH = h;
    }
    if (top !== lastTop) {
      root.style.setProperty('--app-top', `${top}px`);
      lastTop = top;
    }
    const open = innerHeight - h > 120;
    if (open !== keyboardOpen.value) {
      keyboardOpen.value = open;
      document.documentElement.classList.toggle('kb-open', open);
    }
  };
  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(apply);
  };
  apply();
  vv?.addEventListener('resize', schedule);
  vv?.addEventListener('scroll', schedule);
  addEventListener('resize', schedule);
  // iOS sometimes scrolls the document itself when focusing an input.
  addEventListener('scroll', () => {
    if (scrollY !== 0 && !keyboardOpen.value) scrollTo(0, 0);
  });
}
