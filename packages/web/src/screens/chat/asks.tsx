import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { Signal } from '@preact/signals';
import type { ChatItem, PermissionDecision, PermissionItem, QuestionItem } from '@phone-code/protocol';
import { client } from '../../lib/client';
import { chatOf } from '../../lib/state';
import { haptic } from '../../lib/util';
import { GlassSurface } from '../../ui/glass';
import { Icon } from '../../ui/icons';
import { CommandBox, DiffView } from './tools';

function decide(sessionId: string, item: PermissionItem, decision: PermissionDecision, message?: string): void {
  haptic(decision === 'deny' ? 'warning' : 'success');
  // Optimistic: resolve locally right away; the daemon's chat.item confirms it.
  const s = chatOf(sessionId).items.get(item.id);
  if (s) s.value = { ...item, status: decision === 'deny' ? 'denied' : 'allowed' };
  const asks = chatOf(sessionId).asks;
  asks.value = asks.value.filter((x) => x !== item.id);
  client.send({
    t: 'chat.permission',
    sessionId,
    itemId: item.id,
    decision,
    ...(message ? { message } : {}),
  });
}

function preview(p: PermissionItem): JSX.Element | null {
  const d = p.detail;
  if (d?.type === 'command') return <CommandBox command={d.command} cwd={d.cwd} />;
  if (d?.type === 'diff') return <DiffView patch={d.patch} max={14} />;
  if (d?.type === 'file' || d?.type === 'search' || d?.type === 'url') {
    const v = d.type === 'file' ? d.path : d.type === 'search' ? d.query : d.url;
    return <CommandBox command={v} />;
  }
  if (p.input !== undefined) {
    let s = '';
    try {
      s = JSON.stringify(p.input, null, 2);
    } catch {
      s = String(p.input);
    }
    return (
      <div class="tool-output">
        <pre>{s}</pre>
      </div>
    );
  }
  return null;
}

export function PermissionCard({
  sessionId,
  item,
  agent,
}: {
  sessionId: string;
  item: Signal<ChatItem>;
  agent: string;
}): JSX.Element | null {
  const p = item.value;
  const [denying, setDenying] = useState(false);
  const [msg, setMsg] = useState('');
  if (p.kind !== 'permission') return null;

  if (p.status !== 'pending') {
    const label = p.status === 'allowed' ? 'Allowed' : p.status === 'denied' ? 'Denied' : 'Cancelled';
    return (
      <div class={`perm-resolved ps-${p.status}`} data-testid="chat-item-permission" data-status={p.status}>
        <Icon name={p.status === 'allowed' ? 'check' : 'close'} size={14} stroke={2.6} />
        <span>
          {label} <strong>{p.toolName}</strong>
        </span>
        <code>{p.title}</code>
      </div>
    );
  }

  return (
    <div class="perm-card" data-testid="chat-item-permission" data-status="pending" id={`ask-${p.id}`}>
      <div class="perm-head">
        <span class="perm-icon">
          <Icon name="shield" size={18} stroke={2.1} />
        </span>
        <div>
          <div class="perm-title">
            {agent} wants to {p.toolName === 'Bash' ? 'run a command' : p.toolName === 'Edit' || p.toolName === 'Write' ? 'edit a file' : `use ${p.toolName}`}
          </div>
          <div class="perm-sub">{p.title}</div>
        </div>
      </div>
      <div class="perm-preview">{preview(p)}</div>
      {denying ? (
        <div class="perm-deny">
          <textarea
            class="perm-deny-input"
            placeholder="Tell the agent what to do instead (optional)"
            value={msg}
            rows={2}
            aria-label="Reason for denying"
            onInput={(e) => setMsg(e.currentTarget.value)}
            data-testid="permission-deny-message"
          />
          <div class="perm-actions">
            <button type="button" class="btn btn-secondary btn-sm" onClick={() => setDenying(false)}>
              Cancel
            </button>
            <button
              type="button"
              class="btn btn-danger btn-sm"
              onClick={() => decide(sessionId, p, 'deny', msg.trim() || undefined)}
              data-testid="permission-deny-send"
            >
              Deny
            </button>
          </div>
        </div>
      ) : (
        <>
          <div class="perm-actions">
            <button
              type="button"
              class="btn btn-secondary btn-sm perm-deny-btn"
              onClick={() => decide(sessionId, p, 'deny')}
              data-testid="permission-deny"
            >
              Deny
            </button>
            {p.canAllowAlways && (
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                onClick={() => decide(sessionId, p, 'allowAlways')}
                data-testid="permission-allow-always"
              >
                Always allow
              </button>
            )}
            <button
              type="button"
              class="btn btn-primary btn-sm"
              onClick={() => decide(sessionId, p, 'allow')}
              data-testid="permission-allow"
            >
              Allow
            </button>
          </div>
          <button type="button" class="perm-feedback" onClick={() => setDenying(true)} data-testid="permission-deny-feedback">
            Deny with feedback…
          </button>
        </>
      )}
    </div>
  );
}

export function QuestionCard({ sessionId, item }: { sessionId: string; item: Signal<ChatItem> }): JSX.Element | null {
  const q = item.value;
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  if (q.kind !== 'question') return null;

  if (q.status !== 'pending') {
    return (
      <div class="q-resolved" data-testid="chat-item-question" data-status={q.status}>
        {q.questions.map((x) => (
          <div key={x.question}>
            <span class="q-resolved-q">{x.question}</span>
            <span class="q-resolved-a">
              <Icon name="check" size={13} stroke={2.6} />
              {q.answers?.[x.question] ?? (q.status === 'cancelled' ? 'Cancelled' : '—')}
            </span>
          </div>
        ))}
      </div>
    );
  }

  const toggle = (qi: number, label: string, multi: boolean): void => {
    haptic('light');
    const cur = picked[qi] ?? [];
    const next = multi ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label];
    setPicked({ ...picked, [qi]: next });
  };

  const answerFor = (qi: number): string => {
    const labels = (picked[qi] ?? []).filter((l) => l !== '__other');
    const o = (picked[qi] ?? []).includes('__other') ? (other[qi] ?? '').trim() : '';
    return [...labels, ...(o ? [o] : [])].join(', ');
  };
  const complete = q.questions.every((_, i) => answerFor(i));

  const submit = (): void => {
    const answers: Record<string, string> = {};
    q.questions.forEach((x, i) => {
      answers[x.question] = answerFor(i);
    });
    haptic('success');
    const s = chatOf(sessionId).items.get(q.id);
    if (s) s.value = { ...q, status: 'answered', answers };
    const asks = chatOf(sessionId).asks;
    asks.value = asks.value.filter((x) => x !== q.id);
    client.send({ t: 'chat.answer', sessionId, itemId: q.id, answers });
  };

  return (
    <div class="q-card" data-testid="chat-item-question" data-status="pending" id={`ask-${q.id}`}>
      {q.questions.map((x, qi) => {
        const multi = !!x.multiSelect;
        const cur = picked[qi] ?? [];
        return (
          <fieldset key={x.question} class="q-block">
            {x.header && <span class="q-header">{x.header}</span>}
            <legend class="q-question">{x.question}</legend>
            {multi && <div class="q-hint">Choose any</div>}
            <div class="q-options" role={multi ? 'group' : 'radiogroup'}>
              {x.options.map((o) => {
                const on = cur.includes(o.label);
                return (
                  <button
                    key={o.label}
                    type="button"
                    role={multi ? 'checkbox' : 'radio'}
                    aria-checked={on}
                    class={`q-option ${on ? 'on' : ''}`}
                    onClick={() => toggle(qi, o.label, multi)}
                    data-testid="question-option"
                  >
                    <span class={`q-mark ${multi ? 'square' : ''}`} aria-hidden="true">
                      {on && <Icon name="check" size={12} stroke={3.2} />}
                    </span>
                    <span class="q-text">
                      <span class="q-label">{o.label}</span>
                      {o.description && <span class="q-desc">{o.description}</span>}
                    </span>
                  </button>
                );
              })}
              <button
                type="button"
                role={multi ? 'checkbox' : 'radio'}
                aria-checked={cur.includes('__other')}
                class={`q-option ${cur.includes('__other') ? 'on' : ''}`}
                onClick={() => toggle(qi, '__other', multi)}
                data-testid="question-other"
              >
                <span class={`q-mark ${multi ? 'square' : ''}`} aria-hidden="true">
                  {cur.includes('__other') && <Icon name="check" size={12} stroke={3.2} />}
                </span>
                <span class="q-text">
                  <span class="q-label">Something else…</span>
                </span>
              </button>
              {cur.includes('__other') && (
                <input
                  class="q-other-input"
                  placeholder="Type your answer"
                  value={other[qi] ?? ''}
                  aria-label="Your answer"
                  onInput={(e) => setOther({ ...other, [qi]: e.currentTarget.value })}
                  data-testid="question-other-input"
                />
              )}
            </div>
          </fieldset>
        );
      })}
      <button
        type="button"
        class="btn btn-primary btn-block q-submit"
        disabled={!complete}
        onClick={submit}
        data-testid="question-submit"
      >
        Send answer
      </button>
    </div>
  );
}

/** Sticky, always one tap away: the oldest pending ask in this session. */
export function AskBar({ sessionId, agent }: { sessionId: string; agent: string }): JSX.Element | null {
  const c = chatOf(sessionId);
  const asks = c.asks.value;
  const first = asks[0];
  const item = first ? c.items.get(first)?.value : undefined;
  if (!item || (item.kind !== 'permission' && item.kind !== 'question')) return null;
  const reveal = (): void => {
    document.getElementById(`ask-${item.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  return (
    <GlassSurface class="ask-bar" data-testid="ask-bar" data-kind={item.kind}>
      <button type="button" class="ask-info" onClick={reveal}>
        <span class="ask-icon">
          <Icon name={item.kind === 'permission' ? 'shield' : 'question'} size={17} stroke={2.2} />
        </span>
        <span class="ask-text">
          <span class="ask-title">
            {item.kind === 'permission' ? `Allow ${item.toolName}?` : `${agent} has a question`}
            {asks.length > 1 && <span class="ask-count"> · 1 of {asks.length}</span>}
          </span>
          <span class="ask-sub">{item.kind === 'permission' ? item.title : item.questions[0]?.question}</span>
        </span>
      </button>
      {item.kind === 'permission' ? (
        <div class="ask-actions">
          <button
            type="button"
            class="ask-btn deny"
            onClick={() => decide(sessionId, item, 'deny')}
            data-testid="askbar-deny"
            aria-label="Deny"
          >
            <Icon name="close" size={18} stroke={2.6} />
          </button>
          <button
            type="button"
            class="ask-btn allow"
            onClick={() => decide(sessionId, item, 'allow')}
            data-testid="askbar-allow"
          >
            Allow
          </button>
        </div>
      ) : (
        <div class="ask-actions">
          <button type="button" class="ask-btn allow" onClick={reveal} data-testid="askbar-answer">
            Answer
          </button>
        </div>
      )}
    </GlassSurface>
  );
}
