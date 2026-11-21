import type { JSX, TargetedMouseEvent } from 'preact';
import { useSignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import '../../styles/chat.css';
import { copyLastResponse, deleteSession, renameSession } from '../../lib/actions';
import { agentLabel, agentShortLabel, modelLabel, sessionModels } from '../../lib/agents';
import { client } from '../../lib/client';
import { chatOf, conn, host, sessionById } from '../../lib/state';
import { copyText, soon, tildify } from '../../lib/util';
import { BackButton, TopBar } from '../../ui/chrome';
import { GlassButton } from '../../ui/glass';
import { Glyph, glyphOf } from '../../ui/glyph';
import { Icon, Spinner } from '../../ui/icons';
import { openMenu, toast } from '../../ui/overlay';
import { AskBar } from './asks';
import { Composer } from './composer';
import { Transcript, type ScrollApi } from './transcript';

const STATUS_LABEL = {
  idle: 'Ready',
  running: 'Working…',
  waiting: 'Needs you',
  exited: 'Ended',
  error: 'Error',
} as const;

export function ChatScreen({ sessionId, top }: { sessionId: string; top: boolean }): JSX.Element | null {
  const s = sessionById(sessionId);
  const chat = chatOf(sessionId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<ScrollApi>(null);
  const jump = useSignal(false);

  useEffect(() => client.subscribe(sessionId), [sessionId]);

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

  if (!s) return null;
  const agent = agentShortLabel(s, host.value);
  const loaded = chat.loaded.value;
  // While the link is down, say so instead of a status that may be stale.
  const link = conn.value.status === 'open';
  const empty = loaded && chat.ids.value.length === 0 && chat.pending.value.length === 0;

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
          ],
        },
        {
          items: [
            {
              label: 'Delete session',
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
    <div class="screen chat-screen" ref={screenRef} data-testid="screen-chat" data-session-id={sessionId}>
      <div class="scroll chat-scroll" ref={scrollRef}>
        {!loaded ? (
          <div class="center-pad">
            <Spinner size={22} />
          </div>
        ) : empty ? (
          <div class="chat-empty">
            <Glyph kind={glyphOf(s)} size={58} />
            <h2>{agentLabel(s, host.value)}</h2>
            <p>
              in <code class="cmd">{tildify(s.cwd, host.value?.home)}</code>
            </p>
            <p class="chat-empty-hint">
              Ask for a change, a review, or an explanation. It runs on your computer.
            </p>
          </div>
        ) : (
          <Transcript
            chat={chat}
            sessionId={sessionId}
            agent={agent}
            apiRef={apiRef}
            scrollRef={scrollRef}
            jump={jump}
          />
        )}
      </div>
      <TopBar
        fade
        left={<BackButton />}
        titleSlot={
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
              {link ? STATUS_LABEL[s.status] : conn.value.status === 'offline' ? 'Offline' : 'Reconnecting…'}{' '}
              · {modelLabel(s.model, sessionModels(s, host.value)) ?? agent}
            </span>
          </GlassButton>
        }
        right={
          <GlassButton
            icon="ellipsis"
            iconSize={22}
            label="Session menu"
            onClick={menu}
            testid="chat-menu-btn"
          />
        }
      />
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
        {top && <AskBar sessionId={sessionId} agent={agent} />}
        <Composer
          key={sessionId}
          session={s}
          onSent={() => requestAnimationFrame(() => apiRef.current?.toBottom(true))}
        />
      </div>
    </div>
  );
}
