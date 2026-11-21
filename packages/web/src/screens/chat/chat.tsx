import type { JSX, TargetedMouseEvent } from 'preact';
import { useSignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import '../../styles/chat.css';
import { copyLastResponse, deleteSession, renameSession } from '../../lib/actions';
import { client } from '../../lib/client';
import { chatOf, host, sessionById } from '../../lib/state';
import { copyText, tildify } from '../../lib/util';
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
    const ro = new ResizeObserver(() => screen.style.setProperty('--dock-h', `${dock.offsetHeight}px`));
    ro.observe(dock);
    return () => ro.disconnect();
  }, []);

  if (!s) return null;
  const agent = s.agent === 'codex' ? 'Codex' : 'Claude';
  const loaded = chat.loaded.value;
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
            <h2>{agent === 'Claude' ? 'Claude Code' : 'Codex'}</h2>
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
            <span class={`title-sub st-${s.status}`}>
              {s.status === 'running' ? (
                <span class="dot ok pulse" />
              ) : s.status === 'waiting' ? (
                <span class="dot warn" />
              ) : null}
              {STATUS_LABEL[s.status]} · {s.model ?? agent}
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
