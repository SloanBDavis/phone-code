import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { mode, unpair } from './lib/boot';
import { MAX_PANES, closePane, focusPane, focused, openBeside, panes, type Pane } from './lib/nav';
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

/** Where a chat dragged over the panes would land: its pane index once dropped, of `of` panes. */
function dropTarget(e: DragEvent): { at: number; of: number } | null {
  if (!wide.peek() || e.dataTransfer?.types.includes(SESSION_DRAG) !== true) return null;
  if (!(e.currentTarget instanceof HTMLElement)) return null;
  const box = e.currentTarget.getBoundingClientRect();
  const n = panes.peek().length;
  if (n >= MAX_PANES) return { at: focused.peek(), of: n };
  const x = Math.max(0, Math.min(0.9999, (e.clientX - box.left) / box.width));
  return { at: Math.round(x * n), of: n + 1 };
}

/**
 * The main area: the focused pane, or on a wide screen every pane side by
 * side. A chat dragged from the sidebar lands where the highlight shows.
 */
function Main(): JSX.Element {
  const all = panes.value;
  const f = focused.value;
  const shown = wide.value ? all : all.filter((_, i) => i === f);
  const tiled = shown.length > 1;
  /** Where a dragged chat would land: its pane index once dropped, of `of` panes. */
  const [drop, setDrop] = useState<{ at: number; of: number } | null>(null);

  return (
    <div
      class={`panes ${tiled ? 'tiled' : ''}`}
      data-testid="panes"
      data-panes={shown.length}
      onDragOver={(e) => {
        const t = dropTarget(e);
        if (!t) return;
        e.preventDefault();
        if (drop?.at !== t.at || drop.of !== t.of) setDrop(t);
      }}
      onDragLeave={(e) => {
        if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setDrop(null);
      }}
      onDrop={(e) => {
        const t = dropTarget(e);
        const id = e.dataTransfer?.getData(SESSION_DRAG);
        setDrop(null);
        if (!t || !id) return;
        e.preventDefault();
        openBeside({ name: 'session', id }, t.at - 1);
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
      {drop && (
        <div
          class="pane-drop"
          aria-hidden="true"
          data-testid="pane-drop"
          style={{ left: `${(drop.at / drop.of) * 100}%`, width: `${100 / drop.of}%` }}
        />
      )}
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
