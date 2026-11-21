import { signal } from '@preact/signals';

/** Coarse clock for relative timestamps; ticks every 30s while visible. */
export const now = signal(Date.now());

let timer: number | undefined;
function tick(): void {
  now.value = Date.now();
}
export function startClock(): void {
  clearInterval(timer);
  timer = window.setInterval(tick, 30_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick();
  });
}
