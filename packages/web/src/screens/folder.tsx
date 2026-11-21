import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { FsListResult } from '@phone-code/protocol';
import '../styles/folder.css';
import { client } from '../lib/client';
import { host } from '../lib/state';
import { recentDirs } from '../lib/storage';
import { basename, tildify } from '../lib/util';
import { GlassButton } from '../ui/glass';
import { Icon, Spinner } from '../ui/icons';

/** Keeps the end of a long path, which is the part that matters. */
function shortPath(p: string, max = 38): string {
  return p.length <= max ? p : `…${p.slice(p.length - max + 1)}`;
}

/**
 * Where the chat runs. Recent folders first (one tap), then a browser of the
 * host's folders (`fs.list`) starting at the current one.
 */
export default function FolderSheet({
  start,
  onPick,
  close,
}: {
  start: string;
  onPick: (path: string) => void;
  close: () => void;
}): JSX.Element {
  const [path, setPath] = useState(start);
  const [res, setRes] = useState<FsListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let alive = true;
    setError(null);
    client.rpc({ t: 'fs.list', path }).then(
      (r) => alive && setRes(r),
      (e: unknown) => alive && setError(e instanceof Error ? e.message : 'Could not list this folder'),
    );
    return () => {
      alive = false;
    };
  }, [path]);
  const home = host.value?.home;
  const shown = res?.path ?? path;
  const dirs = (res?.entries ?? []).filter((e) => e.dir && (hidden || !e.hidden));
  const recents = recentDirs().filter((r) => r !== shown);
  const pick = (p: string): void => {
    onPick(p);
    close();
  };
  return (
    <div class="folder-pane" data-testid="folder-picker">
      <div class="sheet-head">
        <GlassButton icon="close" label="Close" onClick={close} testid="folder-close" />
        <h2>Folder</h2>
        <GlassButton
          icon="eye"
          label={hidden ? 'Hide hidden folders' : 'Show hidden folders'}
          class={hidden ? 'on' : ''}
          onClick={() => setHidden(!hidden)}
        />
      </div>
      <div class="sheet-scroll">
        {recents.length > 0 && (
          <div class="section">
            <h3 class="section-head">Recent</h3>
            <div class="list">
              {recents.map((r) => (
                <button
                  key={r}
                  type="button"
                  class="cell"
                  onClick={() => pick(r)}
                  data-testid="folder-recent"
                >
                  <span class="cell-icon folder-ic">
                    <Icon name="history" size={16} stroke={2.1} />
                  </span>
                  <span class="cell-main">
                    <span class="cell-title">{basename(r) || '/'}</span>
                    <span class="cell-sub mono">{tildify(r, home)}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div class="section">
          <h3 class="section-head crumb" title={shown}>
            <Icon name="folder" size={14} />
            <span>{shortPath(tildify(shown, home))}</span>
          </h3>
          <div class="list">
            {res?.parent && (
              <button
                type="button"
                class="cell"
                onClick={() => res.parent && setPath(res.parent)}
                data-testid="folder-up"
              >
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
      <div class="folder-foot">
        <button
          type="button"
          class="btn btn-primary btn-block"
          onClick={() => pick(shown)}
          data-testid="folder-choose"
        >
          Use “{basename(shown) || '/'}”
        </button>
      </div>
    </div>
  );
}
