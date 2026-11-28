import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { mode, unpair } from './lib/boot';
import { MAX_PANES, closePane, focusPane, focused, openBeside, openIn, panes, type Pane } from './lib/nav';
import { conn, sessionById, sessionsLoaded } from './lib/state';
import {
  dividers,
  moveSplit,
  resetSplit,
  saveSplits,
  splits,
  tiles,
  type Divider,
  type Tile,
} from './lib/tiles';
import { ChatScreen } from './screens/chat/chat';
import { PairScreen } from './screens/pair';
import { LoadingScreen } from './screens/placeholder';
import { useShortcuts } from './screens/shortcuts';
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

/** A line between tiles: drag it to give one side more room (kept), double-click to even them. */
function TileDivider({ d, area }: { d: Divider; area: { current: HTMLDivElement | null } }): JSX.Element {
  const vertical = d.dir === 'v';
  const move = (e: PointerEvent): void => {
    const box = area.current?.getBoundingClientRect();
    if (!box) return;
    if (vertical) moveSplit(d.key, (e.clientX - box.left) / box.width, box.width);
    else moveSplit(d.key, (e.clientY - box.top) / box.height, box.height);
  };
  const nudge = (by: number): void => {
    const box = area.current?.getBoundingClientRect();
    if (!box) return;
    const size = vertical ? box.width : box.height;
    moveSplit(d.key, d.at + by / size, size);
    saveSplits();
  };
  return (
    <button
      type="button"
      class={`tile-divider ${d.dir}`}
      aria-label={vertical ? 'Resize the chats on either side' : 'Resize the chats above and below'}
      data-testid="tile-divider"
      data-split={d.key}
      style={
        vertical
          ? { left: `${d.at * 100}%`, top: `${d.from * 100}%`, height: `${(d.to - d.from) * 100}%` }
          : { top: `${d.at * 100}%`, left: `${d.from * 100}%`, width: `${(d.to - d.from) * 100}%` }
      }
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.classList.add('dragging');
        area.current?.classList.add('resizing');
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) move(e);
      }}
      onPointerUp={(e) => {
        e.currentTarget.classList.remove('dragging');
        area.current?.classList.remove('resizing');
        saveSplits();
      }}
      onDblClick={() => resetSplit(d.key)}
      onKeyDown={(e) => {
        const back = vertical ? 'ArrowLeft' : 'ArrowUp';
        const on = vertical ? 'ArrowRight' : 'ArrowDown';
        if (e.key !== back && e.key !== on) return;
        e.preventDefault();
        nudge(e.key === back ? -24 : 24);
      }}
    />
  );
}

/**
 * The main area: the focused pane, or on a wide screen every pane as a tile
 * (two or three in a row, four in a 2 by 2 grid), with lines between them
 * that resize them. A chat dragged from the sidebar lands in the tile the
 * highlight shows: the others make room.
 */
function Main(): JSX.Element {
  const all = panes.value;
  const f = focused.value;
  const shown = wide.value ? all : all.filter((_, i) => i === f);
  const tiled = shown.length > 1;
  const [drop, setDrop] = useState<Landing | null>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return undefined;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const s = splits.value;
  const at = tiles(shown.length, width, s);

  return (
    <div
      ref={areaRef}
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
      {shown.map((p, i) => {
        const isFocused = all[f]?.k === p.k;
        const t = at[i] ?? { x: 0, y: 0, w: 1, h: 1 };
        return (
          <section
            key={p.k}
            class={`pane ${isFocused ? 'focused' : ''} ${t.x > 0 ? 'edge-left' : ''} ${t.y > 0 ? 'edge-top' : ''}`}
            aria-label={tiled ? `Pane ${all.indexOf(p) + 1} of ${all.length}` : undefined}
            data-testid="pane"
            data-focused={isFocused}
            style={{
              left: `${t.x * 100}%`,
              top: `${t.y * 100}%`,
              width: `${t.w * 100}%`,
              height: `${t.h * 100}%`,
            }}
            onPointerDownCapture={() => focusPane(p.k)}
            onFocusCapture={() => focusPane(p.k)}
          >
            <PaneContext.Provider value={p.k}>
              <PaneBody p={p} top={isFocused} />
            </PaneContext.Provider>
          </section>
        );
      })}
      {tiled && dividers(shown.length, width, s).map((d) => <TileDivider key={d.key} d={d} area={areaRef} />)}
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
  useShortcuts();
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
