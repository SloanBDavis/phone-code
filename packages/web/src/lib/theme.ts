import { effect, signal } from '@preact/signals';
import { settings } from './storage';

const darkMq = matchMedia('(prefers-color-scheme: dark)');
const systemDark = signal(darkMq.matches);
darkMq.addEventListener('change', () => {
  systemDark.value = darkMq.matches;
});

export const resolvedTheme = signal<'dark' | 'light'>('dark');

/** Background colors per theme; mirrors --bg in tokens.css. */
const BG = { dark: '#0b0b0c', light: '#ffffff' } as const;

export function startTheme(): void {
  effect(() => {
    const pref = settings.value.theme;
    const theme = pref === 'system' ? (systemDark.value ? 'dark' : 'light') : pref;
    resolvedTheme.value = theme;
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    // One theme-color meta that tracks the active theme (the static pair in
    // index.html covers first paint).
    for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      m.content = BG[theme];
    }
  });
}
