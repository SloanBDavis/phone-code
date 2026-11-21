import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { mode, unpair } from './lib/boot';
import { openNew, route } from './lib/nav';
import { conn, sessionById, sessionsLoaded } from './lib/state';
import { ChatScreen } from './screens/chat/chat';
import { PairScreen } from './screens/pair';
import { LoadingScreen } from './screens/placeholder';
import { Sidebar } from './screens/sidebar';
import { Shell } from './ui/drawer';
import { lazy } from './ui/lazy';
import { OverlayHost } from './ui/overlay';

export const TerminalScreen = lazy(() => import('./screens/terminal'), LoadingScreen);

function Main(): JSX.Element {
  const r = route.value;
  const s = r.name === 'session' ? sessionById(r.id) : undefined;
  const gone = r.name === 'session' && !s && sessionsLoaded.value;
  // A chat that is no longer on the host (deleted elsewhere): back to a new chat.
  useEffect(() => {
    if (gone) openNew();
  }, [gone]);
  if (r.name === 'session' && !s) return <LoadingScreen />;
  if (s?.kind === 'terminal') return <TerminalScreen sessionId={s.id} top />;
  return <ChatScreen session={s} />;
}

export function App(): JSX.Element {
  const status = conn.value.status;
  useEffect(() => {
    if (status === 'unauthorized')
      unpair('This device was unpaired from the host. Pair it again to continue.');
  }, [status]);

  return (
    <>
      {mode.value === 'app' ? (
        <Shell sidebar={<Sidebar />}>
          <Main />
        </Shell>
      ) : (
        <PairScreen />
      )}
      <OverlayHost />
    </>
  );
}
