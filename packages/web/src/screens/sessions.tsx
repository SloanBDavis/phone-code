import type { JSX } from 'preact';
import { useComputed } from '@preact/signals';
import type { SessionInfo } from '@phone-code/protocol';
import { deleteSession, renameSession } from '../lib/actions';
import { exitDemo } from '../lib/boot';
import { client } from '../lib/client';
import { now } from '../lib/clock';
import { push } from '../lib/nav';
import { conn, host, isDemo, sessions, sessionsLoaded } from '../lib/state';
import { creds } from '../lib/storage';
import { relTime, tildify } from '../lib/util';
import { useScrolled, TopBar } from '../ui/chrome';
import { GlassButton } from '../ui/glass';
import { Glyph, glyphOf } from '../ui/glyph';
import { Icon, Spinner } from '../ui/icons';
import { lazy } from '../ui/lazy';
import { openSheet } from '../ui/overlay';
import { SwipeRow } from '../ui/swipe-row';

const NewSessionSheet = lazy(() => import('./new-session'));

export function openNewSession(): void {
  void NewSessionSheet.preload();
  openSheet((close) => <NewSessionSheet close={close} />, {
    testid: 'new-session-sheet',
    label: 'New session',
    large: true,
  });
}

export function ConnectionLabel({ showHost = true }: { showHost?: boolean }): JSX.Element {
  const c = conn.value;
  const name = host.value?.name ?? creds.value?.host.name ?? 'your computer';
  const [dot, label] =
    c.status === 'open'
      ? ['ok', isDemo.value ? 'Demo' : 'Connected']
      : c.status === 'offline'
        ? ['bad', 'Offline']
        : c.status === 'unauthorized'
          ? ['bad', 'Unpaired']
          : ['warn pulse', c.status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'];
  return (
    <span class="conn-label" data-testid="conn-state" data-status={c.status}>
      <span class={`dot ${dot}`} />
      {showHost && (
        <>
          <span class="conn-host">{name}</span>
          <span class="conn-sep">·</span>
        </>
      )}
      <span>{label}</span>
    </span>
  );
}

function StatusBadge({ s }: { s: SessionInfo }): JSX.Element | null {
  switch (s.status) {
    case 'running':
      return <span class="badge badge-running" aria-label="Running" />;
    case 'waiting':
      return (
        <span class="badge badge-waiting" aria-label="Needs you">
          !
        </span>
      );
    case 'error':
      return <span class="badge badge-error" aria-label="Error" />;
    case 'exited':
      return <span class="badge badge-exited" aria-label="Exited" />;
    case 'idle':
      return null;
    default: {
      const never: never = s.status;
      return never;
    }
  }
}

function SessionRow({ s }: { s: SessionInfo }): JSX.Element {
  const home = host.value?.home;
  const waitingLabel =
    s.status === 'waiting' ? (s.preview?.startsWith('Wants') ? 'Approval' : 'Question') : null;
  return (
    <SwipeRow
      id={s.id}
      actions={[
        {
          label: 'Rename',
          icon: 'pencil',
          tone: 'neutral',
          onAction: () => void renameSession(s),
          testid: 'session-rename',
        },
        {
          label: 'Delete',
          icon: 'trash',
          tone: 'danger',
          onAction: () => void deleteSession(s),
          testid: 'session-delete',
        },
      ]}
    >
      <button
        type="button"
        class={`session-row status-${s.status}`}
        data-testid="session-row"
        data-session-id={s.id}
        data-status={s.status}
        onClick={() => push({ name: 'session', id: s.id })}
      >
        {s.unread && <span class="unread-dot" data-testid="session-unread" aria-label="Unread" />}
        <span class="session-glyph">
          <Glyph kind={glyphOf(s)} size={46} />
          <StatusBadge s={s} />
        </span>
        <span class="session-main">
          <span class="session-top">
            <span class="session-title">{s.title}</span>
            <span class="session-time">{relTime(s.updatedAt, now.value)}</span>
          </span>
          <span class="session-cwd">
            <Icon name="folder" size={13} stroke={2} />
            {tildify(s.cwd, home)}
          </span>
          <span class="session-preview">
            {waitingLabel && <span class="pill-attention">{waitingLabel}</span>}
            {s.status === 'running' && <Spinner size={12} />}
            <span class="session-preview-text">
              {s.preview ?? (s.kind === 'terminal' ? 'Shell' : 'No messages yet')}
            </span>
          </span>
        </span>
      </button>
    </SwipeRow>
  );
}

function Section({
  title,
  list,
  tone,
  testid,
}: {
  title: string;
  list: SessionInfo[];
  tone?: 'attention';
  testid: string;
}): JSX.Element | null {
  if (!list.length) return null;
  return (
    <section class="section" data-testid={testid}>
      <h2 class={`section-head ${tone ?? ''}`}>
        <span>{title}</span>
        <span class="count">{list.length}</span>
      </h2>
      <div class="list session-list">
        {list.map((s) => (
          <SessionRow key={s.id} s={s} />
        ))}
      </div>
    </section>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div class="empty sessions-empty" data-testid="sessions-empty">
      <div class="empty-glyphs" aria-hidden="true">
        <Glyph kind="codex" size={52} />
        <Glyph kind="claude" size={64} />
        <Glyph kind="terminal" size={52} />
      </div>
      <h2>Nothing running yet</h2>
      <p>
        Start Claude Code, Codex or a terminal on <strong>{host.value?.name ?? 'your computer'}</strong>. It
        keeps running when you lock your phone.
      </p>
      <button type="button" class="btn btn-primary" onClick={openNewSession} data-testid="empty-new">
        <Icon name="plus" size={20} stroke={2.4} />
        New session
      </button>
    </div>
  );
}

export function SessionsScreen({ top }: { top: boolean }): JSX.Element {
  const [scrollRef, scrolled] = useScrolled<HTMLDivElement>(30);
  const groups = useComputed(() => {
    const all = sessions.value;
    return {
      waiting: all.filter((s) => s.status === 'waiting'),
      running: all.filter((s) => s.status === 'running'),
      recent: all.filter((s) => s.status !== 'waiting' && s.status !== 'running'),
    };
  });
  const g = groups.value;
  const c = conn.value.status;
  void top;

  return (
    <div class="screen grouped" data-testid="screen-sessions">
      <div class="scroll" ref={scrollRef}>
        <h1 class="large-title">Sessions</h1>
        <div class="large-sub">
          <ConnectionLabel />
          {(c === 'reconnecting' || c === 'offline') && (
            <button type="button" class="link-btn" onClick={() => client.retryNow()} data-testid="conn-retry">
              Retry
            </button>
          )}
        </div>
        {isDemo.value && (
          <div class="demo-banner" data-testid="demo-banner">
            <Icon name="sparkle" size={18} />
            <span>
              You're exploring a <strong>simulated</strong> computer.
            </span>
            <button type="button" class="link-btn" onClick={exitDemo}>
              Exit demo
            </button>
          </div>
        )}
        {!sessionsLoaded.value ? (
          <div class="center-pad">
            <Spinner size={22} />
          </div>
        ) : sessions.value.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <Section title="Needs you" list={g.waiting} tone="attention" testid="section-waiting" />
            <Section title="Running" list={g.running} testid="section-running" />
            <Section title="Recent" list={g.recent} testid="section-recent" />
            <p class="list-hint">Swipe a row left to rename or delete it.</p>
          </>
        )}
      </div>
      <TopBar
        title="Sessions"
        showTitle={scrolled}
        fade={scrolled}
        right={
          <GlassButton
            icon="gear"
            label="Settings"
            onClick={() => push({ name: 'settings' })}
            testid="open-settings"
          />
        }
      />
      <div class="edge-fade bottom" aria-hidden="true" />
      <div class="bottom-actions">
        <GlassButton
          variant="tinted"
          class="new-btn"
          onClick={openNewSession}
          testid="new-session"
          label="New session"
          icon="plus"
          iconSize={22}
        >
          New
        </GlassButton>
      </div>
    </div>
  );
}
