import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { Signal } from '@preact/signals';
import type { ChatItem } from '@phone-code/protocol';
import { client } from '../../lib/client';
import type { PendingSend } from '../../lib/state';
import { duration } from '../../lib/util';
import { picsOf, type Pic } from '../../lib/images';
import { Icon } from '../../ui/icons';
import { Thumbs } from '../../ui/thumbs';
import { Markdown } from './md';

const srcPics = (urls: string[]): Pic[] => urls.map((src, i) => ({ key: `${i}:${src.slice(-24)}`, src }));

export function UserBubble({
  item,
  sessionId,
}: {
  item: Signal<ChatItem>;
  sessionId: string;
}): JSX.Element | null {
  const u = item.value;
  if (u.kind !== 'user') return null;
  // Newer daemons send refs; older ones inline the bytes (or drop them: say how many).
  const pics = u.images?.length
    ? picsOf(sessionId, u.images)
    : srcPics((u.attachments ?? []).filter((a) => a.data).map((a) => `data:${a.mediaType};base64,${a.data}`));
  const missing = u.images?.length ? 0 : (u.attachments ?? []).filter((a) => !a.data).length;
  return (
    <div class="msg-user" data-testid="chat-item-user">
      <Thumbs pics={pics} variant="bubble" />
      {missing > 0 && (
        <div class="bubble-att-note">
          <Icon name="photo" size={14} /> {missing} photo{missing > 1 ? 's' : ''}
        </div>
      )}
      {u.text && <div class="bubble">{u.text}</div>}
    </div>
  );
}

export function PendingBubble({
  p,
  sessionId,
  onRetry,
}: {
  p: PendingSend;
  sessionId?: string;
  onRetry?: () => void;
}): JSX.Element {
  const progress = p.status === 'sending' && p.images.length > 0 ? (p.progress ?? 0) : null;
  return (
    <div class={`msg-user pending ${p.status}`} data-testid="chat-item-pending" data-status={p.status}>
      <Thumbs pics={srcPics(p.images)} variant="bubble" progress={progress} />
      {p.text && <div class="bubble">{p.text}</div>}
      {p.status === 'failed' && (
        <button
          type="button"
          class="bubble-retry"
          onClick={() => (onRetry ? onRetry() : sessionId && client.retrySend(sessionId, p.localId))}
        >
          <Icon name="warn" size={14} stroke={2.2} /> Not sent{p.error ? `: ${p.error}` : ''}. Tap to retry
        </button>
      )}
    </div>
  );
}

export function TextBlock({
  item,
  sessionId,
}: {
  item: Signal<ChatItem>;
  sessionId: string;
}): JSX.Element | null {
  const t = item.value;
  if (t.kind !== 'text') return null;
  return (
    <div class="msg-text" data-testid="chat-item-text" data-streaming={t.streaming}>
      <Markdown text={t.text} streaming={t.streaming} />
      {t.images?.length ? <Thumbs pics={picsOf(sessionId, t.images)} variant="inline" /> : null}
    </div>
  );
}

export function ThinkingBlock({ item }: { item: Signal<ChatItem> }): JSX.Element | null {
  const t = item.value;
  const [open, setOpen] = useState(false);
  if (t.kind !== 'thinking') return null;
  const last = t.text.trim().split('\n').pop() ?? '';
  return (
    <div
      class={`thinking ${open ? 'open' : ''} ${t.streaming ? 'live' : ''}`}
      data-testid="chat-item-thinking"
    >
      <button type="button" class="thinking-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="sparkle" size={14} stroke={2.1} />
        <span class="thinking-label">{t.streaming ? 'Thinking' : 'Thought process'}</span>
        <Icon name={open ? 'up' : 'down'} size={13} stroke={2.5} />
      </button>
      {open ? (
        <div class="thinking-body">{t.text}</div>
      ) : (
        t.streaming && last && <div class="thinking-peek">{last}</div>
      )}
    </div>
  );
}

export function NoticeRow({ item }: { item: Signal<ChatItem> }): JSX.Element | null {
  const n = item.value;
  if (n.kind !== 'notice') return null;
  return (
    <div class={`notice lvl-${n.level}`} data-testid="chat-item-notice">
      <Icon name={n.level === 'info' ? 'info' : 'warn'} size={14} stroke={2.1} />
      <span>{n.text}</span>
    </div>
  );
}

export function TurnFooter({ item }: { item: Signal<ChatItem> }): JSX.Element | null {
  const t = item.value;
  if (t.kind !== 'turn') return null;
  const parts: string[] = [];
  if (t.durationMs !== undefined) parts.push(duration(t.durationMs));
  if (t.costUsd !== undefined) parts.push(`$${t.costUsd.toFixed(2)}`);
  const tokens = (t.inputTokens ?? 0) + (t.outputTokens ?? 0);
  if (tokens) parts.push(`${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens`);
  return (
    <div class={`turn turn-${t.outcome}`} data-testid="chat-item-turn" data-outcome={t.outcome}>
      <span class="turn-line" />
      <span class="turn-text">
        {t.outcome === 'interrupted'
          ? 'Stopped'
          : t.outcome === 'error'
            ? (t.error ?? 'Turn failed')
            : 'Done'}
        {parts.length > 0 && <span class="turn-meta"> · {parts.join(' · ')}</span>}
      </span>
      <span class="turn-line" />
    </div>
  );
}
