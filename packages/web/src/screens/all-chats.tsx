import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AgentId, HistoryQuery, ResumableSession } from '@phone-code/protocol';
import { openSession } from '../lib/actions';
import { agentCatalog } from '../lib/agents';
import { client } from '../lib/client';
import { now } from '../lib/clock';
import { resumeChat } from '../lib/harness';
import { host } from '../lib/state';
import { basename, haptic, relTime } from '../lib/util';
import { Glyph, agentGlyph } from '../ui/glyph';
import { Spinner } from '../ui/icons';

const PAGE = 40;
const DEBOUNCE_MS = 220;

/** Shows `text` with the matches of `q` marked. */
function Marked({ text, q }: { text: string; q: string }): JSX.Element {
  const needle = q.trim().toLowerCase();
  if (!needle) return <>{text}</>;
  const parts: JSX.Element[] = [];
  const low = text.toLowerCase();
  let i = 0;
  for (let at = low.indexOf(needle); at >= 0; at = low.indexOf(needle, i)) {
    if (at > i) parts.push(<>{text.slice(i, at)}</>);
    parts.push(<mark>{text.slice(at, at + needle.length)}</mark>);
    i = at + needle.length;
  }
  parts.push(<>{text.slice(i)}</>);
  return <>{parts}</>;
}

/**
 * A daemon from before text search ignores `query` and returns everything:
 * keep what matches the title or folder, and whatever it matched itself (it
 * says so with a snippet).
 */
function matches(r: ResumableSession, q: string): boolean {
  const n = q.trim().toLowerCase();
  return !n || !!r.snippet || r.title.toLowerCase().includes(n) || r.cwd.toLowerCase().includes(n);
}

type State =
  | { k: 'loading' }
  | { k: 'error'; message: string }
  | { k: 'ok'; items: ResumableSession[]; more: boolean; loadingMore: boolean };

/**
 * "All chats": every conversation on the host from every harness, started on
 * the phone or at the computer, archived or not. Search as you type; before
 * typing, the most recent ones. Opening one puts it in the sidebar.
 */
export default function AllChats({ text, onOpen }: { text: string; onOpen: () => void }): JSX.Element {
  const [agent, setAgent] = useState<AgentId | null>(null);
  const [state, setState] = useState<State>({ k: 'loading' });
  const genRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const agents = agentCatalog(host.value).filter((a) => a.available || a.impl === 'native');
  const q = text.trim();

  const fetchPage = async (before?: number): Promise<{ items: ResumableSession[]; more: boolean }> => {
    const query: HistoryQuery = { limit: PAGE, ...(q ? { text: q } : {}), ...(before ? { before } : {}) };
    const res = await client.rpc({ t: 'history.list', ...(agent ? { agent } : {}), query });
    const list = Array.isArray(res) ? res : [];
    return { items: list.filter((r) => matches(r, q)), more: list.length >= PAGE };
  };

  useEffect(() => {
    const gen = ++genRef.current;
    setState((s) => (s.k === 'ok' && q ? s : { k: 'loading' }));
    const t = setTimeout(
      () => {
        fetchPage().then(
          (r) => gen === genRef.current && setState({ k: 'ok', ...r, loadingMore: false }),
          (e: unknown) =>
            gen === genRef.current &&
            setState({ k: 'error', message: e instanceof Error ? e.message : 'Search failed' }),
        );
      },
      q ? DEBOUNCE_MS : 0,
    );
    return () => clearTimeout(t);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- fetchPage reads only q and agent
  }, [q, agent]);

  const loadMore = (): void => {
    if (state.k !== 'ok' || !state.more || state.loadingMore) return;
    const last = state.items[state.items.length - 1];
    const gen = genRef.current;
    setState({ ...state, loadingMore: true });
    fetchPage(last?.updatedAt).then(
      (r) => {
        if (gen !== genRef.current) return undefined;
        return setState((s) =>
          s.k === 'ok'
            ? {
                k: 'ok',
                items: [
                  ...s.items,
                  ...r.items.filter((x) => !s.items.some((y) => y.resumeId === x.resumeId)),
                ],
                more: r.more && r.items.length > 0,
                loadingMore: false,
              }
            : s,
        );
      },
      () =>
        gen === genRef.current &&
        setState((s) => (s.k === 'ok' ? { ...s, more: false, loadingMore: false } : s)),
    );
  };

  const hasMore = state.k === 'ok' && state.more;
  // Next page when the end of the list scrolls into view.
  const moreRef = useRef(loadMore);
  useLayoutEffect(() => {
    moreRef.current = loadMore;
  });
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !('IntersectionObserver' in window)) return undefined;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && moreRef.current(), {
      rootMargin: '200px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore]);

  const open = (r: ResumableSession): void => {
    haptic('light');
    onOpen();
    if (r.sessionId) openSession(r.sessionId);
    else void resumeChat({ agent: r.agent, resumeId: r.resumeId, cwd: r.cwd, title: r.title });
  };

  const name = (id: AgentId, fallback?: string): string =>
    fallback ?? agents.find((a) => a.id === id)?.name ?? id;

  return (
    <div class="all-chats" data-testid="all-chats">
      {agents.length > 1 && (
        <fieldset class="filter-chips" aria-label="Harness">
          <button
            type="button"
            class={`chip ${agent === null ? 'on' : ''}`}
            aria-pressed={agent === null}
            onClick={() => setAgent(null)}
            data-testid="history-filter-all"
          >
            All
          </button>
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              class={`chip ${agent === a.id ? 'on' : ''}`}
              aria-pressed={agent === a.id}
              onClick={() => setAgent(agent === a.id ? null : a.id)}
              data-testid={`history-filter-${a.id}`}
            >
              {a.name}
            </button>
          ))}
        </fieldset>
      )}
      <h2 class="sb-head">{q ? 'Results' : 'Recent on this computer'}</h2>
      {state.k === 'loading' && (
        <div class="center-pad" data-testid="history-loading">
          <Spinner size={20} />
        </div>
      )}
      {state.k === 'error' && (
        <p class="sb-empty" data-testid="history-error">
          Could not list the chats on this computer. {state.message}
        </p>
      )}
      {state.k === 'ok' && state.items.length === 0 && (
        <p class="sb-empty" data-testid="history-empty">
          {q ? `No chats match “${q}”.` : 'No conversations on this computer yet.'}
        </p>
      )}
      {state.k === 'ok' &&
        state.items.map((r) => (
          <button
            key={`${r.agent}:${r.resumeId}`}
            type="button"
            class="sb-row history-row"
            data-testid="history-row"
            data-agent={r.agent}
            data-session-id={r.sessionId}
            data-archived={r.archived ? 'true' : undefined}
            onClick={() => open(r)}
          >
            <span class="sb-glyph">
              <Glyph kind={agentGlyph(r.agent)} size={34} />
            </span>
            <span class="sb-main">
              <span class="sb-top">
                <span class="sb-title">
                  <Marked text={r.title} q={q} />
                </span>
                <span class="sb-time">{relTime(r.updatedAt, now.value)}</span>
              </span>
              {r.snippet && (
                <span class="sb-snippet" data-testid="history-snippet">
                  <Marked text={r.snippet.replace(/[*`_#>]+/g, '')} q={q} />
                </span>
              )}
              <span class="sb-sub">
                <span class="sb-sub-text">
                  {name(r.agent, r.agentName)} · {basename(r.cwd) || r.cwd}
                </span>
                {r.archived && <span class="pill-muted">Archived</span>}
              </span>
            </span>
          </button>
        ))}
      {state.k === 'ok' && state.more && (
        <div ref={sentinelRef} class="center-pad" data-testid="history-more">
          {state.loadingMore ? (
            <Spinner size={18} />
          ) : (
            <button type="button" class="link-btn" onClick={loadMore}>
              Show more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
