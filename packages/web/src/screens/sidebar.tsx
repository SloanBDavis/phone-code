import type { ButtonHTMLAttributes, JSX } from 'preact';
import { useComputed } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_AGENT, type SessionInfo } from '@phone-code/protocol';
import { archiveSession, deleteSession, openSession, renameSession } from '../lib/actions';
import { agentLabel, isCursorChat } from '../lib/agents';
import { exitDemo } from '../lib/boot';
import { client } from '../lib/client';
import { now } from '../lib/clock';
import { connectionOf } from '../lib/connection';
import { moveInList } from '../lib/keys';
import { MAX_PANES, openBeside, openIds, openNew, panes, route } from '../lib/nav';
import { canPairPhone, pairPhone } from '../lib/shell';
import { conn, host, isDemo, sessions, sessionsLoaded } from '../lib/state';
import { creds } from '../lib/storage';
import { relTime } from '../lib/util';
import { SESSION_DRAG, closeDrawer, wide } from '../ui/drawer';
import { GlassButton } from '../ui/glass';
import { Glyph, glyphOf } from '../ui/glyph';
import { Icon, Spinner } from '../ui/icons';
import { lazy } from '../ui/lazy';
import { openMenu, openSheet } from '../ui/overlay';
import { SwipeRow } from '../ui/swipe-row';

const AllChats = lazy(() => import('./all-chats'));
const ComputerSheet = lazy(() => import('./settings'));

export function openComputer(): void {
  void ComputerSheet.preload();
  openSheet((close) => <ComputerSheet close={close} />, {
    testid: 'computer-sheet',
    label: 'This computer',
    large: true,
  });
}

/** Host name and how the phone reaches it: quiet, always there. Opens "This computer". */
export function ConnectionLabel(): JSX.Element {
  const c = conn.value;
  const name = host.value?.name ?? creds.value?.host.name ?? 'your computer';
  const info = connectionOf(host.value);
  const [dot, label] =
    c.status === 'open'
      ? isDemo.value
        ? ['ok', 'Demo']
        : info.secure
          ? ['ok', 'Secure']
          : ['warn', 'Plain http']
      : c.status === 'offline'
        ? ['bad', 'Offline']
        : c.status === 'unauthorized'
          ? ['bad', 'Unpaired']
          : ['warn pulse', c.status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'];
  return (
    <span class="conn-label" data-testid="conn-state" data-status={c.status} data-secure={info.secure}>
      <span class={`dot ${dot}`} />
      <span class="conn-host">{name}</span>
      <span class="conn-sep">·</span>
      <span>{label}</span>
    </span>
  );
}

function Status({ s }: { s: SessionInfo }): JSX.Element | null {
  if (s.status === 'running') return <Spinner size={12} />;
  if (s.status === 'waiting')
    return (
      <span class="pill-attention">
        {isCursorChat(s)
          ? 'Reply'
          : /^(?:Wants|Needs permission)\b/.test(s.preview ?? '')
            ? 'Approval'
            : 'Question'}
      </span>
    );
  if (s.status === 'error') return <span class="badge-error-dot" aria-label="Error" />;
  return null;
}

/** Long press (touch) or right click (mouse) opens the row's menu. */
function useLongPress(onLong: (el: Element) => void): {
  handlers: ButtonHTMLAttributes;
  fired: () => boolean;
} {
  const timerRef = useRef(0);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);
  const cancel = (): void => {
    clearTimeout(timerRef.current);
    startRef.current = null;
  };
  useEffect(() => {
    const opts = { capture: true, passive: true };
    const types = ['pointerup', 'pointercancel', 'touchend', 'touchcancel', 'blur'] as const;
    for (const t of types) addEventListener(t, cancel, opts);
    return () => {
      clearTimeout(timerRef.current);
      for (const t of types) removeEventListener(t, cancel, opts);
    };
  }, []);
  return {
    fired: () => {
      const f = firedRef.current;
      firedRef.current = false;
      return f;
    },
    handlers: {
      onPointerDown: (e) => {
        if (e.pointerType === 'mouse') return;
        firedRef.current = false;
        startRef.current = { x: e.clientX, y: e.clientY };
        const el = e.currentTarget;
        clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => {
          startRef.current = null;
          firedRef.current = true;
          onLong(el);
        }, 480);
      },
      onPointerMove: (e) => {
        const s = startRef.current;
        if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 8) cancel();
      },
      onContextMenu: (e) => {
        e.preventDefault();
        cancel();
        onLong(e.currentTarget);
      },
    },
  };
}

function rowMenu(anchor: Element, s: SessionInfo): void {
  openMenu(
    anchor,
    [
      {
        items: [
          ...(wide.peek() && !openIds.peek().has(s.id)
            ? [
                {
                  label: panes.peek().length < MAX_PANES ? 'Open beside' : 'Open in this pane',
                  icon: 'split' as const,
                  onSelect: () => openBeside({ name: 'session', id: s.id }),
                  testid: 'menu-open-beside',
                },
              ]
            : []),
          { label: 'Rename', icon: 'pencil', onSelect: () => void renameSession(s), testid: 'menu-rename' },
          {
            label: 'Archive',
            icon: 'archive',
            onSelect: () => void archiveSession(s),
            testid: 'menu-archive',
          },
        ],
      },
      {
        items: [
          {
            label: 'Delete',
            icon: 'trash',
            destructive: true,
            onSelect: () => void deleteSession(s),
            testid: 'menu-delete',
          },
        ],
      },
    ],
    { testid: 'row-menu' },
  );
}

/**
 * A chat row from the keyboard: ↑ ↓ Home End move between rows, ⌘⏎ opens beside, F2
 * renames, ⇧F10 or the menu key shows its actions, ⌫ archives (⌘⌫ deletes, asking).
 */
function rowKey(e: KeyboardEvent & { currentTarget: HTMLButtonElement }, s: SessionInfo): void {
  const row = e.currentTarget;
  const list = row.closest('[data-testid="sidebar-list"]') ?? document;
  const search = document.querySelector<HTMLElement>('[data-testid="search-input"]');
  if (moveInList(e, list, '[data-testid="session-row"]', search)) return;
  const mod = e.metaKey || e.ctrlKey;
  if (e.altKey) return;
  if (e.key === 'Enter' && mod && wide.peek()) {
    e.preventDefault();
    openBeside({ name: 'session', id: s.id });
    return;
  }
  if (e.key === 'F2') {
    e.preventDefault();
    void renameSession(s);
    return;
  }
  if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
    e.preventDefault();
    rowMenu(row, s);
    return;
  }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    void (mod ? deleteSession(s) : archiveSession(s));
  }
}

function SessionRow({ s, active, open }: { s: SessionInfo; active: boolean; open: boolean }): JSX.Element {
  const press = useLongPress((el) => rowMenu(el, s));
  const sub =
    s.status === 'waiting'
      ? ''
      : (s.preview ?? (s.kind === 'terminal' ? 'Terminal' : agentLabel(s, host.value)));
  return (
    <SwipeRow
      id={s.id}
      actions={[
        {
          label: 'Archive',
          icon: 'archive',
          tone: 'accent',
          onAction: () => void archiveSession(s),
          testid: 'session-archive',
        },
      ]}
    >
      <button
        type="button"
        class={`sb-row status-${s.status} ${active ? 'active' : open ? 'open' : ''}`}
        draggable={wide.value}
        onDragStart={(e) => {
          e.dataTransfer?.setData(SESSION_DRAG, s.id);
          e.dataTransfer?.setData('text/plain', s.title);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove';
        }}
        aria-current={active ? 'page' : undefined}
        data-testid="session-row"
        data-session-id={s.id}
        data-agent={s.kind === 'agent' ? (s.agent ?? DEFAULT_AGENT) : undefined}
        data-status={s.status}
        {...press.handlers}
        onKeyDown={(e) => rowKey(e, s)}
        onClick={(e) => {
          if (press.fired()) return;
          // Cmd/Ctrl-click: beside the open chats, in a pane of its own.
          if (wide.peek() && (e.metaKey || e.ctrlKey)) return openBeside({ name: 'session', id: s.id });
          openSession(s.id);
          closeDrawer();
        }}
      >
        <span class="sb-glyph" title={s.kind === 'agent' ? agentLabel(s, host.value) : 'Terminal'}>
          <Glyph kind={glyphOf(s)} size={34} />
        </span>
        <span class="sb-main">
          <span class="sb-top">
            <span class="sb-title">{s.title}</span>
            <span class="sb-time">{relTime(s.updatedAt, now.value)}</span>
          </span>
          <span class="sb-sub">
            <Status s={s} />
            <span class="sb-sub-text">{sub}</span>
            {s.unread && <span class="unread-dot" data-testid="session-unread" aria-label="Unread" />}
          </span>
        </span>
      </button>
    </SwipeRow>
  );
}

function ChatList(): JSX.Element {
  const groups = useComputed(() => {
    const shown = sessions.value.filter((s) => !s.archived);
    return {
      waiting: shown.filter((s) => s.status === 'waiting'),
      // Every other chat, whatever harness it is (Cursor's app included).
      rest: shown.filter((s) => s.status !== 'waiting'),
    };
  });
  const r = route.value;
  const activeId = r.name === 'session' ? r.id : null;
  const open = openIds.value;
  const g = groups.value;
  if (!sessionsLoaded.value)
    return (
      <div class="center-pad">
        <Spinner size={20} />
      </div>
    );
  if (!g.waiting.length && !g.rest.length)
    return (
      <p class="sb-empty" data-testid="sessions-empty">
        Your chats show up here. Search above to find the ones you started on your computer.
      </p>
    );
  return (
    <>
      {g.waiting.length > 0 && (
        <section class="sb-section" data-testid="section-waiting">
          <h2 class="sb-head attention">Needs you</h2>
          {g.waiting.map((s) => (
            <SessionRow key={s.id} s={s} active={s.id === activeId} open={open.has(s.id)} />
          ))}
        </section>
      )}
      {g.rest.length > 0 && (
        <section class="sb-section" data-testid="section-chats">
          {g.waiting.length > 0 && <h2 class="sb-head">Chats</h2>}
          {g.rest.map((s) => (
            <SessionRow key={s.id} s={s} active={s.id === activeId} open={open.has(s.id)} />
          ))}
        </section>
      )}
    </>
  );
}

export function Sidebar(): JSX.Element {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const c = conn.value.status;

  const stopSearch = (): void => {
    setQuery('');
    setSearching(false);
    inputRef.current?.blur();
  };

  return (
    <div class="sb" data-searching={searching}>
      <div class="sb-top-bar">
        <button
          type="button"
          class="sb-host"
          onClick={openComputer}
          data-testid="open-computer"
          aria-label="This computer"
        >
          <span class="sb-host-icon">
            <Icon name="laptop" size={18} stroke={1.9} />
          </span>
          <ConnectionLabel />
        </button>
        {(c === 'reconnecting' || c === 'offline') && (
          <button type="button" class="link-btn" onClick={() => client.retryNow()} data-testid="conn-retry">
            Retry
          </button>
        )}
        <span class="spacer" />
        {canPairPhone() && (
          <GlassButton
            icon="qr"
            label="Pair a phone"
            title="Pair a phone (⇧⌘P)"
            iconSize={19}
            testid="sidebar-pair-phone"
            onClick={pairPhone}
          />
        )}
        <GlassButton
          icon="compose"
          label="New chat"
          iconSize={20}
          testid="sidebar-new-chat"
          onClick={() => {
            stopSearch();
            openNew();
            closeDrawer();
          }}
        />
      </div>
      <div class="sb-search">
        <label class="search-field">
          <Icon name="search" size={16} stroke={2.2} />
          <input
            ref={inputRef}
            type="search"
            value={query}
            placeholder="Search all chats"
            aria-label="Search all chats"
            enterkeyhint="search"
            autocomplete="off"
            data-testid="search-input"
            onFocus={() => void AllChats.preload()}
            // A tap or click opens "All chats"; reaching the field with Tab does not
            // (the list below would change under the keyboard). Typing does either way.
            onPointerDown={() => setSearching(true)}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setSearching(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') stopSearch();
              // ↓ from the field: into the list below it.
              if (e.key === 'ArrowDown') {
                const first = document.querySelector<HTMLElement>(
                  '[data-testid="sidebar-list"] [data-testid="session-row"], [data-testid="sidebar-list"] [data-testid="history-row"]',
                );
                if (first) {
                  e.preventDefault();
                  first.focus();
                }
              }
            }}
          />
        </label>
        {searching && (
          <button type="button" class="link-btn" onClick={stopSearch} data-testid="search-cancel">
            Cancel
          </button>
        )}
      </div>
      {isDemo.value && !searching && (
        <div class="demo-banner" data-testid="demo-banner">
          <Icon name="sparkle" size={16} />
          <span>A simulated computer.</span>
          <button type="button" class="link-btn" onClick={exitDemo}>
            Exit demo
          </button>
        </div>
      )}
      <div class="sb-scroll" data-testid="sidebar-list">
        {searching ? (
          <AllChats
            text={query}
            onOpen={() => {
              stopSearch();
              if (!wide.peek()) closeDrawer();
            }}
          />
        ) : (
          <ChatList />
        )}
      </div>
    </div>
  );
}
