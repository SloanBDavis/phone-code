import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { mode, unpair } from './lib/boot';
import { closePane, focusPane, focused, openBeside, panes, type Pane } from './lib/nav';
import { conn, sessionById, sessionsLoaded } from './lib/state';
import { ChatScreen } from './screens/chat/chat';
import { PairScreen } from './screens/pair';
import { LoadingScreen } from './screens/placeholder';
import { Sidebar } from './screens/sidebar';
import { PaneContext, SESSION_DRAG, Shell, wide } from './ui/drawer';
import { lazy } from './ui/lazy';
import { OverlayHost } from './ui/overlay';

export const TerminalScreen = lazy(() => import('./screens/terminal'), LoadingScreen);

function PaneBody({ p, top }: { p: Pane; top: boolean }): JSX.Element {
  const r = p.r;
  const s = r.name === 'session' ? sessionById(r.id) : undefined;
  const gone = r.name === 'session' && !s && sessionsLoaded.value;
  // A chat that is no longer on the host (deleted elsewhere): its pane closes (the only pane: a new chat).
  useEffect(() => {
    if (gone) closePane(p.k);
  }, [gone, p.k]);
  if (r.name === 'session' && !s) return <LoadingScreen />;
  if (s?.kind === 'terminal') return <TerminalScreen sessionId={s.id} top={top} />;
  return <ChatScreen session={s} />;
}

/** A chat from the sidebar, dragged over the main area on a wide screen. */
const carriesChat = (e: DragEvent): boolean =>
  wide.peek() && e.dataTransfer?.types.includes(SESSION_DRAG) === true;

/**
 * The main area: the focused pane, or on a wide screen every pane side by
 * side (two or three in a row, four in a 2 by 2 grid). A chat dragged from
 * the sidebar becomes a new tile.
 */
function Main(): JSX.Element {
  const all = panes.value;
  const f = focused.value;
  const shown = wide.value ? all : all.filter((_, i) => i === f);
  const tiled = shown.length > 1;
  const [drop, setDrop] = useState(false);

  return (
    <div
      class={`panes ${tiled ? 'tiled' : ''}`}
      data-testid="panes"
      data-panes={shown.length}
      onDragOver={(e) => {
        if (!carriesChat(e)) return;
        e.preventDefault();
        setDrop(true);
      }}
      onDragLeave={(e) => {
        if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setDrop(false);
      }}
      onDrop={(e) => {
        const id = carriesChat(e) ? e.dataTransfer?.getData(SESSION_DRAG) : undefined;
        setDrop(false);
        if (!id) return;
        e.preventDefault();
        openBeside({ name: 'session', id }, panes.peek().length - 1);
      }}
    >
      {shown.map((p) => {
        const isFocused = all[f]?.k === p.k;
        return (
          <section
            key={p.k}
            class={`pane ${isFocused ? 'focused' : ''}`}
            aria-label={tiled ? `Pane ${all.indexOf(p) + 1} of ${all.length}` : undefined}
            data-testid="pane"
            data-focused={isFocused}
            onPointerDownCapture={() => focusPane(p.k)}
            onFocusCapture={() => focusPane(p.k)}
          >
            <PaneContext.Provider value={p.k}>
              <PaneBody p={p} top={isFocused} />
            </PaneContext.Provider>
          </section>
        );
      })}
      {drop && <div class="pane-drop" aria-hidden="true" data-testid="pane-drop" />}
    </div>
  );
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
