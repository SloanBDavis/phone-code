import { render } from 'preact';
import './styles/tokens.css';
import './styles/base.css';
import './styles/glass.css';
import './styles/overlay.css';
import './styles/sessions.css';
import { App } from './app';
import { autoCode, mode, readLaunchParams, startDemo, startHost } from './lib/boot';
import { startClock } from './lib/clock';
import { refractionSupported, startGlassHighlights } from './lib/glass';
import { push, startNav } from './lib/nav';
import { creds } from './lib/storage';
import { startTheme } from './lib/theme';
import { trackViewport } from './lib/viewport';

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

if (refractionSupported()) document.documentElement.classList.add('refract');
startTheme();
trackViewport(root);
startClock();
startGlassHighlights();

const launch = readLaunchParams();
if (launch.pairCode) {
  autoCode.value = launch.pairCode;
  mode.value = 'pair';
} else if (launch.demo) {
  void startDemo();
} else if (creds.value) {
  startHost();
} else if (launch.handoff) {
  // First launch of the Home Screen app: redeem the handoff code.
  autoCode.value = launch.handoff;
  mode.value = 'pair';
}
startNav();

render(<App />, root);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  });
  navigator.serviceWorker.addEventListener(
    'message',
    (e: MessageEvent<{ type?: string; sessionId?: string }>) => {
      if (e.data.type === 'open-session' && e.data.sessionId) push({ name: 'session', id: e.data.sessionId });
    },
  );
}

// After phone-code is updated on the host, the chunks of the build this page
// came from are gone: reload once into the new build instead of breaking.
addEventListener('vite:preloadError', (e) => {
  try {
    // At most once per 30 s, so a chunk that is really missing cannot cause a reload loop.
    if (Date.now() - Number(sessionStorage.getItem('pc.chunkReload') ?? 0) < 30_000) return;
    sessionStorage.setItem('pc.chunkReload', String(Date.now()));
  } catch {
    return;
  }
  e.preventDefault();
  location.reload();
});

// Warm the chunks the user is likely to open next once the first paint is done.
const idle = (fn: () => void): void => {
  if ('requestIdleCallback' in window) requestIdleCallback(fn, { timeout: 3000 });
  else setTimeout(fn, 1500);
};
idle(() => {
  if (mode.value !== 'app') return;
  void import('./screens/chat/markdown');
  void import('./screens/terminal');
});
