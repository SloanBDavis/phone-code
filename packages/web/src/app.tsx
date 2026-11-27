import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { mode, unpair } from './lib/boot';
import { MAX_PANES, closePane, focusPane, focused, openBeside, openIn, panes, type Pane } from './lib/nav';
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

interface Tile {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Below this width three tiles are one tall and two stacked (the stylesheet's `@container main`). */
const THREE_IN_A_ROW = 1260;

/** Where `count` tiles sit in a main area `width` wide, as fractions of it: the stylesheet's grid. */
function tiles(count: number, width: number): Tile[] {
  if (count <= 1) return [{ x: 0, y: 0, w: 1, h: 1 }];
  if (count === 2 || (count === 3 && width >= THREE_IN_A_ROW))
    return Array.from({ length: count }, (_, i) => ({ x: i / count, y: 0, w: 1 / count, h: 1 }));
  if (count === 3)
    return [
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ];
  return Array.from({ length: count }, (_, i) => ({
    x: (i % 2) / 2,
    y: Math.floor(i / 2) / 2,
    w: 0.5,
    h: 0.5,
  }));
}

/** Where a dragged chat would land: which tile, of the tiles there will be once it is dropped. */
interface Landing {
  index: number;
  tile: Tile;
  /** Every tile is taken: it takes this one's place. */
  replaces: boolean;
}

function landing(e: DragEvent): Landing | null {
  if (!carriesChat(e) || !(e.currentTarget instanceof HTMLElement)) return null;
  const box = e.currentTarget.getBoundingClientRect();
  const n = panes.peek().length;
  const replaces = n >= MAX_PANES;
  const after = tiles(replaces ? n : n + 1, box.width);
  const px = (e.clientX - box.left) / box.width;
  const py = (e.clientY - box.top) / box.height;
  const index = after.findIndex((t) => px >= t.x && px < t.x + t.w && py >= t.y && py < t.y + t.h);
  const tile = after[index];
  return tile ? { index, tile, replaces } : null;
}

/**
 * The main area: the focused pane, or on a wide screen every pane side by
 * side (two or three in a row, four in a 2 by 2 grid). A chat dragged from
 * the sidebar lands in the tile the highlight shows: the others make room.
 */
function Main(): JSX.Element {
  const all = panes.value;
  const f = focused.value;
  const shown = wide.value ? all : all.filter((_, i) => i === f);
  const tiled = shown.length > 1;
  const [drop, setDrop] = useState<Landing | null>(null);

  return (
    <div
      class={`panes ${tiled ? 'tiled' : ''}`}
      data-testid="panes"
      data-panes={shown.length}
      onDragOver={(e) => {
        const to = landing(e);
        if (!to) return;
        e.preventDefault();
        if (drop?.index !== to.index || drop.tile.w !== to.tile.w || drop.tile.h !== to.tile.h) setDrop(to);
      }}
      onDragLeave={(e) => {
        if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setDrop(null);
      }}
      onDrop={(e) => {
        const to = landing(e);
        const id = e.dataTransfer?.getData(SESSION_DRAG);
        setDrop(null);
        if (!to || !id) return;
        e.preventDefault();
        const r = { name: 'session' as const, id };
        if (to.replaces) openIn(to.index, r);
        else openBeside(r, to.index - 1);
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
          style={{
            left: `${drop.tile.x * 100}%`,
            top: `${drop.tile.y * 100}%`,
            width: `${drop.tile.w * 100}%`,
            height: `${drop.tile.h * 100}%`,
          }}
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
