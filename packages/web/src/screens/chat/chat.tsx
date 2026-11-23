import type { JSX, TargetedMouseEvent } from 'preact';
import { useSignal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { SessionInfo } from '@phone-code/protocol';
import '../../styles/chat.css';
import {
  archiveSession,
  copyLastResponse,
  deleteSession,
  renameSession,
  setCursorConnected,
} from '../../lib/actions';
import { CURSOR_APP, agentShortLabel } from '../../lib/agents';
import { client } from '../../lib/client';
import { connectionOf } from '../../lib/connection';
import { draft, harnessList, openTerminal, retryStart, starting } from '../../lib/harness';
import { chatOf, conn, host, isDemo } from '../../lib/state';
import { loadDraft, markSeen, seen } from '../../lib/storage';
import { basename, copyText, haptic, soon, tildify } from '../../lib/util';
import { TopBar } from '../../ui/chrome';
import { paneButtons } from '../../ui/drawer';
import { GlassButton } from '../../ui/glass';
import { Glyph } from '../../ui/glyph';
import { Icon, Spinner } from '../../ui/icons';
import { openMenu, toast } from '../../ui/overlay';
import { openComputer } from '../sidebar';
import { AskBar } from './asks';
import { Composer } from './composer';
import { PendingBubble } from './items';
import { Transcript, type ScrollApi } from './transcript';

const STATUS_LABEL = {
  idle: 'Ready',
  running: 'Working…',
  waiting: 'Needs you',
  exited: 'Ended',
  error: 'Error',
} as const;

const STARTERS = [
  'Explain how this project is organized',
  'Find and fix a failing test',
  'Review my uncommitted changes',
];

/** Plain http, said once, in the first new chat: what is limited and how to fix it. */
function HttpNote(): JSX.Element | null {
  const [hidden, setHidden] = useState(() => seen('http'));
  if (hidden || isDemo.value || connectionOf(host.value).secure) return null;
  return (
    <div class="http-note" data-testid="http-note">
      <Icon name="info" size={17} />
      <span>
        This connection is plain http: no notifications or opening without a connection.{' '}
        <button type="button" class="link-btn" onClick={openComputer}>
          How to fix
        </button>
      </span>
      <button
        type="button"
        class="link-btn"
        data-testid="http-note-dismiss"
        onClick={() => {
          markSeen('http');
          setHidden(true);
        }}
      >
        OK
      </button>
    </div>
  );
}

/**
 * Cursor is on this computer but not followed: one line offering it, until
 * connected or dismissed (the switch also lives in This computer).
 */
function CursorSuggestion(): JSX.Element | null {
  const [hidden, setHidden] = useState(() => seen('cursor'));
  const [busy, setBusy] = useState(false);
  const c = host.value?.cursor;
  if (hidden || !c?.installed || c.connected) return null;
  const connect = (): void => {
    haptic('light');
    setBusy(true);
    setCursorConnected(true)
      .then(() => toast('Following your Cursor chats', 'check'))
      .catch((e: unknown) => toast(e instanceof Error ? e.message : 'Could not connect Cursor', 'warn'))
      .finally(() => setBusy(false));
  };
  return (
    <div class="cursor-suggestion" data-testid="cursor-suggestion">
      <Glyph kind={CURSOR_APP} size={28} />
      <span class="cursor-suggestion-text">
        <span class="cursor-suggestion-title">Follow your Cursor chats here</span>
        <span class="cursor-suggestion-sub">See them live and reply when a turn ends.</span>
      </span>
      <button
        type="button"
        class="btn btn-primary btn-sm"
        disabled={busy}
        onClick={connect}
        data-testid="cursor-connect"
      >
        {busy ? <Spinner size={15} /> : 'Connect'}
      </button>
      <button
        type="button"
        class="cursor-suggestion-x"
        aria-label="Not now"
        data-testid="cursor-dismiss"
        onClick={() => {
          markSeen('cursor');
          setHidden(true);
        }}
      >
        <Icon name="close" size={14} stroke={2.6} />
      </button>
    </div>
  );
}

/** A new chat before its first message: what it will run, a few ideas, or how to set up an agent. */
function NewChatEmpty({ onStarter }: { onStarter: (t: string) => void }): JSX.Element {
  const d = draft.value;
  const h = host.value;
  const ready = harnessList().filter((x) => x.available && x.id !== 'terminal');
  const name = h?.name ?? 'your computer';
  if (h && ready.length === 0)
    return (
      <div class="chat-empty" data-testid="new-chat-empty" data-state="no-agent">
        <CursorSuggestion />
        <Glyph kind="app" size={58} />
        <h2>No coding agent on {name} yet</h2>
        <p>Install one on your computer and it shows up here. Meanwhile, the terminal works.</p>
        <ul class="setup-hints" data-testid="setup-hints">
          {harnessList()
            .filter((x) => !x.available)
            .map((x) => (
              <li key={x.id}>
                <strong>{x.info?.name ?? x.id}</strong>
                <span>{x.info?.setupHint ?? 'Not installed'}</span>
              </li>
            ))}
        </ul>
        <button type="button" class="btn btn-secondary" onClick={() => void openTerminal()}>
          <Icon name="terminal" size={18} />
          Open a terminal
        </button>
        <HttpNote />
      </div>
    );
  return (
    <div class="chat-empty" data-testid="new-chat-empty" data-state={d.info?.available ? 'ready' : 'setup'}>
      <CursorSuggestion />
      <Glyph kind="app" size={58} />
      <h2>{d.info?.name ?? 'New chat'}</h2>
      <p>
        in <code class="cmd">{tildify(d.cwd, h?.home)}</code> on {name}
      </p>
      {d.info && (!d.info.available || d.info.setupHint) && (
        <p class="harness-hint" data-testid="harness-hint">
          <Icon name="warn" size={16} />
          {d.info.setupHint ?? 'Not installed on this computer.'}
        </p>
      )}
      {d.info?.available !== false && (
        <div class="starters">
          {STARTERS.map((s) => (
            <button key={s} type="button" class="starter" data-testid="starter" onClick={() => onStarter(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      <HttpNote />
    </div>
  );
}

function TitleCapsule({ s }: { s?: SessionInfo }): JSX.Element {
  const link = conn.value.status === 'open';
  if (!s)
    return (
      <div class="title-capsule glass glass-regular glass-btn glass-capsule static" data-testid="chat-title">
        <span class="title-main">New chat</span>
        {!link && (
          <span class="title-sub st-away">
            <span class="dot warn pulse" />
            {conn.value.status === 'offline' ? 'Offline' : 'Connecting…'}
          </span>
        )}
      </div>
    );
  const menu = (e: TargetedMouseEvent<HTMLButtonElement>): void =>
    openMenu(
      e.currentTarget,
      [
        {
          items: [
            { label: 'Rename', icon: 'pencil', onSelect: () => void renameSession(s), testid: 'menu-rename' },
            {
              label: 'Copy last response',
              icon: 'copy',
              onSelect: () => void copyLastResponse(s.id),
              testid: 'menu-copy',
            },
            {
              label: 'Copy folder path',
              icon: 'folder',
              hint: tildify(s.cwd, host.value?.home),
              onSelect: () => void copyText(s.cwd).then((ok) => ok && toast('Copied', 'check')),
            },
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
              label: 'Delete chat',
              icon: 'trash',
              destructive: true,
              onSelect: () => void deleteSession(s),
              testid: 'menu-delete',
            },
          ],
        },
      ],
      { testid: 'chat-menu' },
    );
  return (
    <GlassButton class="title-capsule" onClick={menu} testid="chat-title">
      <span class="title-main">{s.title}</span>
      <span class={`title-sub st-${link ? s.status : 'away'}`} data-link={conn.value.status}>
        {!link ? (
          <span class="dot warn pulse" />
        ) : s.status === 'running' ? (
          <span class="dot ok pulse" />
        ) : s.status === 'waiting' ? (
          <span class="dot warn" />
        ) : null}
        {link ? STATUS_LABEL[s.status] : conn.value.status === 'offline' ? 'Offline' : 'Reconnecting…'} ·{' '}
        {s.cwd === host.value?.home ? '~' : basename(s.cwd) || s.cwd}
      </span>
    </GlassButton>
  );
}

/**
 * The chat pane: a new chat (no `session`) or a session's transcript. The
 * same instance serves both, so sending the first message turns the new
 * chat into its session without the keyboard going down.
 */
export function ChatScreen({ session: s }: { session?: SessionInfo }): JSX.Element {
  const sessionId = s?.id;
  const chat = sessionId ? chatOf(sessionId) : null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<ScrollApi>(null);
  const jump = useSignal(false);
  const [text, setText] = useState(() => loadDraft(sessionId ?? 'new'));
  const { left, right } = paneButtons();

  useEffect(() => (sessionId ? client.subscribe(sessionId) : undefined), [sessionId]);

  // The transcript scrolls under the floating dock; keep its padding equal to the dock height.
  useEffect(() => {
    const dock = dockRef.current;
    const screen = screenRef.current;
    if (!dock || !screen) return undefined;
    // Written outside the observer callback: the padding resizes the transcript, which has its own
    // observer, and a same-frame chain is reported by WebKit as "ResizeObserver loop" errors.
    let cancel = (): void => undefined;
    const ro = new ResizeObserver(() => {
      cancel();
      cancel = soon(() => screen.style.setProperty('--dock-h', `${dock.offsetHeight}px`), 16);
    });
    ro.observe(dock);
    return () => {
      cancel();
      ro.disconnect();
    };
  }, []);

  const agent = s
    ? agentShortLabel(s, host.value)
    : agentShortLabel({ agent: draft.value.harness }, host.value);
  const loaded = chat?.loaded.value ?? true;
  const first = starting.value;
  const empty = !chat || (loaded && chat.ids.value.length === 0 && chat.pending.value.length === 0);

  return (
    <div
      class="screen chat-screen"
      ref={screenRef}
      data-testid="screen-chat"
      data-session-id={sessionId ?? ''}
      data-draft={!s}
    >
      <div class="scroll chat-scroll" ref={scrollRef}>
        {!s ? (
          first ? (
            <div class="transcript">
              <PendingBubble p={first} onRetry={retryStart} />
              {first.status === 'sending' && (
                <div class="center-pad">
                  <Spinner size={18} />
                </div>
              )}
            </div>
          ) : (
            <NewChatEmpty
              onStarter={(t) => {
                setText(t);
                soon(() => document.querySelector<HTMLTextAreaElement>('.composer-input')?.focus());
              }}
            />
          )
        ) : !loaded ? (
          <div class="center-pad">
            <Spinner size={22} />
          </div>
        ) : empty ? (
          <div class="chat-empty">
            <Glyph kind="app" size={58} />
            <h2>{s.title}</h2>
            <p>
              in <code class="cmd">{tildify(s.cwd, host.value?.home)}</code>
            </p>
          </div>
        ) : (
          <Transcript
            key={s.id}
            chat={chat}
            sessionId={s.id}
            agent={agent}
            apiRef={apiRef}
            scrollRef={scrollRef}
            jump={jump}
          />
        )}
      </div>
      <TopBar fade left={left} titleSlot={<TitleCapsule s={s} />} right={right} />
      <button
        type="button"
        class={`jump glass glass-regular ${jump.value ? 'show' : ''}`}
        onClick={() => apiRef.current?.toBottom(true)}
        aria-label="Jump to latest"
        tabIndex={jump.value ? 0 : -1}
        data-testid="jump-latest"
      >
        <Icon name="arrowDown" size={18} stroke={2.4} />
      </button>
      <div class="dock" ref={dockRef}>
        {s && <AskBar sessionId={s.id} agent={agent} />}
        <Composer
          session={s}
          text={text}
          setText={setText}
          onSent={() => soon(() => apiRef.current?.toBottom(true))}
        />
      </div>
    </div>
  );
}
