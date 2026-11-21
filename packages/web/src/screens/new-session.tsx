import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { AgentKind, CreateSessionParams, FsListResult, PermissionMode, ResumableSession } from '@phone-code/protocol';
import '../styles/new-session.css';
import '../styles/settings.css';
import { client } from '../lib/client';
import { now } from '../lib/clock';
import { push } from '../lib/nav';
import { host, sessions } from '../lib/state';
import { pushRecentDir, recentDirs, settings } from '../lib/storage';
import { basename, haptic, relTime, tildify } from '../lib/util';
import { GlassButton } from '../ui/glass';
import { Glyph, agentName, type GlyphKind } from '../ui/glyph';
import { Icon, Spinner } from '../ui/icons';
import { openMenu, toast } from '../ui/overlay';
import { MODES, modeInfo } from './chat/composer';

function termSize(): { cols: number; rows: number } {
  const fs = settings.value.termFontSize;
  const app = document.querySelector('.app');
  const w = app?.clientWidth ?? innerWidth;
  const h = app?.clientHeight ?? innerHeight;
  return { cols: Math.max(40, Math.floor((w - 12) / (fs * 0.6))), rows: Math.max(12, Math.floor((h - 160) / (fs * 1.25))) };
}

function FolderPicker({
  start,
  onPick,
  onBack,
}: {
  start: string;
  onPick: (path: string) => void;
  onBack: () => void;
}): JSX.Element {
  const [path, setPath] = useState(start);
  const [res, setRes] = useState<FsListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let alive = true;
    setError(null);
    client
      .rpc({ t: 'fs.list', path })
      .then((r) => {
        if (alive) setRes(r);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : 'Could not list this folder');
      });
    return () => {
      alive = false;
    };
  }, [path]);
  const dirs = (res?.entries ?? []).filter((e) => e.dir && (hidden || !e.hidden));
  const home = host.value?.home;
  const shown = res?.path ?? path;
  return (
    <div class="ns-pane folder-pane" data-testid="folder-picker">
      <div class="sheet-head">
        <GlassButton icon="back" label="Back" onClick={onBack} testid="folder-back" />
        <h2>Choose folder</h2>
        <GlassButton
          icon="eye"
          label={hidden ? 'Hide hidden folders' : 'Show hidden folders'}
          class={hidden ? 'on' : ''}
          onClick={() => setHidden(!hidden)}
        />
      </div>
      <div class="crumb" title={shown}>
        <Icon name="folder" size={15} />
        <span>{tildify(shown, home)}</span>
      </div>
      <div class="sheet-scroll">
        <div class="section">
          <div class="list">
            {res?.parent && (
              <button type="button" class="cell" onClick={() => res.parent && setPath(res.parent)} data-testid="folder-up">
                <span class="cell-icon folder-ic up">
                  <Icon name="up" size={17} stroke={2.4} />
                </span>
                <span class="cell-main cell-title">{basename(res.parent) || '/'}</span>
                <span class="cell-value">Up</span>
              </button>
            )}
            {!res && !error && (
              <div class="cell static">
                <Spinner size={18} />
              </div>
            )}
            {error && <div class="cell static cell-sub">{error}</div>}
            {res && dirs.length === 0 && <div class="cell static cell-sub">No folders here</div>}
            {dirs.map((d) => (
              <button
                key={d.name}
                type="button"
                class="cell"
                onClick={() => setPath(`${shown === '/' ? '' : shown}/${d.name}`)}
                data-testid="folder-entry"
              >
                <span class="cell-icon folder-ic">
                  <Icon name="folder" size={17} stroke={2} />
                </span>
                <span class={`cell-main cell-title ${d.hidden ? 'dim' : ''}`}>{d.name}</span>
                <Icon name="forward" size={15} stroke={2.4} class="cell-chev" />
              </button>
            ))}
          </div>
        </div>
      </div>
      <div class="ns-foot">
        <button type="button" class="btn btn-primary btn-block" onClick={() => onPick(shown)} data-testid="folder-choose">
          Use “{basename(shown) || '/'}”
        </button>
      </div>
    </div>
  );
}

export default function NewSessionSheet({ close }: { close: () => void }): JSX.Element {
  const h = host.value;
  const agents = h?.agents ?? [];
  const available = (k: AgentKind): boolean => agents.some((a) => a.kind === k && a.available);
  const firstKind: GlyphKind = available('claude') ? 'claude' : available('codex') ? 'codex' : 'terminal';
  const [kind, setKind] = useState<GlyphKind>(firstKind);
  const recents = recentDirs();
  const [cwd, setCwd] = useState<string>(recents[0] ?? h?.home ?? '~');
  const [picking, setPicking] = useState(false);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [perm, setPerm] = useState<PermissionMode>('default');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<ResumableSession[] | null>(null);

  const agentInfo = kind === 'terminal' ? undefined : agents.find((a) => a.kind === kind);
  const models = agentInfo?.models ?? [];

  useEffect(() => {
    setModel(undefined);
    if (kind === 'terminal') return;
    let alive = true;
    setHistory(null);
    client
      .rpc({ t: 'history.list', agent: kind })
      .then((r) => {
        if (alive) setHistory(r);
      })
      .catch(() => {
        if (alive) setHistory([]);
      });
    return () => {
      alive = false;
    };
  }, [kind]);

  const create = async (params: CreateSessionParams): Promise<void> => {
    setBusy(true);
    haptic('medium');
    try {
      const s = await client.rpc({ t: 'session.create', params });
      if (params.cwd) pushRecentDir(params.cwd);
      if (!sessions.peek().some((x) => x.id === s.id)) sessions.value = [s, ...sessions.peek()];
      close();
      setTimeout(() => push({ name: 'session', id: s.id }), 120);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not start the session', 'warn');
      setBusy(false);
    }
  };

  const start = (): void => {
    if (kind === 'terminal') void create({ kind: 'terminal', cwd, ...termSize() });
    else void create({ kind: 'agent', agent: kind, cwd, ...(model ? { model } : {}), permissionMode: perm });
  };

  if (picking)
    return (
      <FolderPicker
        start={cwd}
        onBack={() => setPicking(false)}
        onPick={(p) => {
          setCwd(p);
          setPicking(false);
        }}
      />
    );

  const kinds: GlyphKind[] = ['claude', 'codex', 'terminal'];
  const home = h?.home;

  return (
    <div class="ns-pane">
      <div class="sheet-head">
        <span class="glass-btn glass-circle ghost" />
        <h2>New session</h2>
        <GlassButton icon="close" label="Close" onClick={close} testid="new-session-close" />
      </div>
      <div class="sheet-scroll">
        <div class="kind-tiles" role="radiogroup" aria-label="Session type">
          {kinds.map((k) => {
            const off = k !== 'terminal' && !available(k);
            const info = k === 'terminal' ? undefined : agents.find((a) => a.kind === k);
            return (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                class={`kind-tile ${kind === k ? 'on' : ''}`}
                disabled={off}
                onClick={() => {
                  haptic('light');
                  setKind(k);
                }}
                data-testid={`new-kind-${k}`}
              >
                <Glyph kind={k} size={44} />
                <span class="kind-name">{agentName(k)}</span>
                <span class="kind-sub">
                  {off ? 'Not installed' : k === 'terminal' ? (h?.shell.split('/').pop() ?? 'shell') : info?.version ? `v${info.version}` : 'Ready'}
                </span>
              </button>
            );
          })}
        </div>

        <div class="section">
          <div class="list">
            <button type="button" class="cell" onClick={() => setPicking(true)} data-testid="new-folder">
              <span class="cell-icon folder-ic">
                <Icon name="folder" size={17} stroke={2} />
              </span>
              <span class="cell-main">
                <span class="cell-title">{basename(cwd) || '/'}</span>
                <span class="cell-sub mono">{tildify(cwd, home)}</span>
              </span>
              <Icon name="forward" size={15} stroke={2.4} class="cell-chev" />
            </button>
            {kind !== 'terminal' && (
              <>
                <button
                  type="button"
                  class="cell"
                  disabled={!models.length}
                  data-testid="new-model"
                  onClick={(e) =>
                    openMenu(e.currentTarget, [
                      {
                        title: 'Model',
                        items: [
                          { label: 'Default', checked: !model, onSelect: () => setModel(undefined) },
                          ...models.map((m) => ({ label: m, checked: m === model, onSelect: () => setModel(m) })),
                        ],
                      },
                    ])
                  }
                >
                  <span class="cell-icon" style={{ background: '#5e5ce6' }}>
                    <Icon name="sparkle" size={16} stroke={2.1} />
                  </span>
                  <span class="cell-main cell-title">Model</span>
                  <span class="cell-value">{model ?? 'Default'}</span>
                  <Icon name="down" size={14} stroke={2.4} class="cell-chev" />
                </button>
                <button
                  type="button"
                  class="cell"
                  data-testid="new-permission"
                  onClick={(e) =>
                    openMenu(e.currentTarget, [
                      {
                        title: 'Permissions',
                        items: MODES.map((m) => ({
                          label: m.label,
                          hint: m.hint,
                          icon: m.icon,
                          destructive: m.mode === 'bypassPermissions',
                          checked: m.mode === perm,
                          onSelect: () => setPerm(m.mode),
                        })),
                      },
                    ])
                  }
                >
                  <span class="cell-icon" style={{ background: perm === 'bypassPermissions' ? '#ff5a4f' : '#ff9f0a' }}>
                    <Icon name={modeInfo(perm).icon} size={16} stroke={2.1} />
                  </span>
                  <span class="cell-main cell-title">Permissions</span>
                  <span class="cell-value">{modeInfo(perm).label}</span>
                  <Icon name="down" size={14} stroke={2.4} class="cell-chev" />
                </button>
              </>
            )}
          </div>
          {recents.length > 0 && (
            <div class="recent-dirs" aria-label="Recent folders">
              {recents.map((r) => (
                <button
                  key={r}
                  type="button"
                  class={`chip ${r === cwd ? 'on' : ''}`}
                  onClick={() => setCwd(r)}
                  data-testid="new-recent-dir"
                >
                  <Icon name="history" size={13} stroke={2.2} />
                  {basename(r)}
                </button>
              ))}
            </div>
          )}
        </div>

        <div class="ns-start">
          <button type="button" class="btn btn-primary btn-block" disabled={busy} onClick={start} data-testid="new-start">
            {busy ? <Spinner size={18} /> : null}
            Start {agentName(kind)}
          </button>
        </div>

        {kind !== 'terminal' && (
          <div class="section">
            <h3 class="section-head">Resume a past session</h3>
            <div class="list">
              {history === null && (
                <div class="cell static">
                  <Spinner size={18} />
                </div>
              )}
              {history?.length === 0 && <div class="cell static cell-sub">No past {agentName(kind)} sessions found.</div>}
              {history?.map((r) => (
                <button
                  key={r.resumeId}
                  type="button"
                  class="cell resume-cell"
                  disabled={busy}
                  onClick={() =>
                    void create({ kind: 'agent', agent: r.agent, cwd: r.cwd, resumeId: r.resumeId, title: r.title, permissionMode: perm })
                  }
                  data-testid="resume-row"
                >
                  <span class="cell-main">
                    <span class="cell-title">{r.title}</span>
                    <span class="cell-sub">
                      <span class="mono">{tildify(r.cwd, home)}</span>
                      {' · '}
                      {relTime(r.updatedAt, now.value)}
                      {r.messageCount ? ` · ${r.messageCount} messages` : ''}
                    </span>
                  </span>
                  <Icon name="history" size={18} stroke={2} class="cell-chev" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
