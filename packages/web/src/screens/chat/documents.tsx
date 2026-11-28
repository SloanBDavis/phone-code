import type { JSX } from 'preact';
import type { Signal } from '@preact/signals';
import type { ChatItem, ToolDetail } from '@phone-code/protocol';
import { client } from '../../lib/client';
import { findDocument, sessions, type ChatState } from '../../lib/state';
import { haptic } from '../../lib/util';
import { GlassButton } from '../../ui/glass';
import { Icon, Spinner } from '../../ui/icons';
import { openSheet, toast } from '../../ui/overlay';
import { Markdown } from './md';

type DocumentDetail = Extract<ToolDetail, { type: 'document' }>;

/** What a plan that waits for review is answered with. */
export const PROCEED = 'Proceed';

/** The document, full screen, as Markdown. */
export function openDocument(d: DocumentDetail): void {
  if (d.text === undefined) return;
  const text = d.text;
  openSheet(
    (close) => (
      <>
        <div class="sheet-head">
          <span class="glass-btn ghost" aria-hidden="true" />
          <h2>{d.title}</h2>
          <GlassButton icon="close" label="Close" iconSize={18} onClick={close} testid="document-close" />
        </div>
        <div class="sheet-scroll doc-body" data-testid="document-view">
          <Markdown text={text} />
          {d.textTruncated && <p class="tool-note">The rest of this document is on your computer.</p>}
        </div>
      </>
    ),
    { testid: 'document-sheet', label: d.title, large: true },
  );
}

/** A link in the chat to a file on the computer: the document the agent wrote there, if this phone has it. */
export function openDocumentAt(path: string): void {
  const d = findDocument(path);
  if (d) openDocument(d);
  else toast('That file is on your computer', 'laptop');
}

/**
 * Whether a document is the agent's latest word and waits for the user: it asked for a
 * review, nothing was sent after it, and the agent is not at work.
 */
function waitsForReview(chat: ChatState, id: string, sessionId: string): boolean {
  const ids = chat.ids.value;
  const at = ids.indexOf(id);
  if (at < 0 || chat.pending.value.length > 0) return false;
  if (ids.slice(at + 1).some((x) => chat.kinds.get(x) === 'user')) return false;
  const status = sessions.value.find((s) => s.id === sessionId)?.status;
  return status === 'idle';
}

/**
 * A plan, a task list or a walkthrough the agent wrote (Antigravity's artifacts): its
 * title and summary, opened by a tap. A plan that waits for a review offers Proceed.
 */
export function DocumentCard({
  chat,
  item,
  sessionId,
}: {
  chat: ChatState;
  item: Signal<ChatItem>;
  sessionId: string;
}): JSX.Element | null {
  const t = item.value;
  if (t.kind !== 'tool' || t.detail?.type !== 'document') return null;
  const d = t.detail;
  const ready = d.text !== undefined;
  const review = d.requestFeedback === true && ready && waitsForReview(chat, t.id, sessionId);
  return (
    <div class="doc-card" data-testid="chat-item-document" data-status={t.status}>
      <button
        type="button"
        class="doc-open"
        disabled={!ready}
        onClick={() => openDocument(d)}
        data-testid="document-open"
      >
        <span class="doc-icon">
          <Icon name="doc" size={18} stroke={2} />
        </span>
        <span class="doc-main">
          <span class="doc-title">{d.title}</span>
          {d.summary && <span class="doc-summary">{d.summary}</span>}
        </span>
        {ready ? <Icon name="forward" size={14} stroke={2.4} class="tool-chev" /> : <Spinner size={14} />}
      </button>
      {review && (
        <div class="doc-actions">
          <span class="doc-ask">Waiting for your review</span>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            data-testid="document-proceed"
            onClick={() => {
              haptic('light');
              void client.sendChat(sessionId, PROCEED);
            }}
          >
            {PROCEED}
          </button>
        </div>
      )}
    </div>
  );
}
