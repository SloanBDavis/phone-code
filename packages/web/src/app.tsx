import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { mode, unpair } from './lib/boot';
import type { Route } from './lib/nav';
import { conn, sessionById, sessionsLoaded } from './lib/state';
import { ChatScreen } from './screens/chat/chat';
import { PairScreen } from './screens/pair';
import { SessionsScreen } from './screens/sessions';
import { SettingsScreen } from './screens/settings';
import { lazy } from './ui/lazy';
import { OverlayHost } from './ui/overlay';
import { Stack } from './ui/stack';
import { MissingScreen, LoadingScreen } from './screens/placeholder';

export const TerminalScreen = lazy(() => import('./screens/terminal'), LoadingScreen);

function renderRoute(route: Route, top: boolean): JSX.Element {
  switch (route.name) {
    case 'home':
      return <SessionsScreen top={top} />;
    case 'settings':
      return <SettingsScreen />;
    case 'session': {
      const s = sessionById(route.id);
      if (!s) return sessionsLoaded.value ? <MissingScreen /> : <LoadingScreen />;
      return s.kind === 'terminal' ? (
        <TerminalScreen sessionId={s.id} top={top} />
      ) : (
        <ChatScreen sessionId={s.id} top={top} />
      );
    }
    default: {
      const never: never = route;
      return never;
    }
  }
}

export function App(): JSX.Element {
  const status = conn.value.status;
  useEffect(() => {
    if (status === 'unauthorized') unpair('This device was unpaired from the host. Pair it again to continue.');
  }, [status]);

  return (
    <>
      {mode.value === 'app' ? <Stack render={renderRoute} /> : <PairScreen />}
      <OverlayHost />
    </>
  );
}

