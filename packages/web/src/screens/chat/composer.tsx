import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Attachment, SessionInfo, SlashCommand } from '@phone-code/protocol';
import { agentShortLabel } from '../../lib/agents';
import { client } from '../../lib/client';
import { groupCommands, sessionCommands, SOURCE_LABEL } from '../../lib/commands';
import { agentInfo, draft, startChat, starting } from '../../lib/harness';
import { downscaleImage } from '../../lib/image';
import { host } from '../../lib/state';
import { loadDraft, saveDraft } from '../../lib/storage';
import { haptic } from '../../lib/util';
import { GlassSurface } from '../../ui/glass';
import { Icon } from '../../ui/icons';
import { toast } from '../../ui/overlay';
import { FolderChip, HarnessChip, ModeChip, ModelChip } from './pickers';

export { MODES, modeInfo } from './pickers';

const MAX_ROWS_PX = 168;
const MAX_PHOTOS = 6;
const NEW = 'new';

/** `/comp` at the very start, before any space: what the palette filters by. */
const slashToken = (text: string): string | null => /^\/(\S*)$/.exec(text)?.[1] ?? null;

function Palette({
  groups,
  active,
  onPick,
}: {
  groups: ReturnType<typeof groupCommands>;
  active: number;
  onPick: (c: SlashCommand) => void;
}): JSX.Element {
  const activeName = groups.flatMap((g) => g.items)[active]?.name;
  return (
    <GlassSurface class="slash-palette" data-testid="slash-palette" aria-label="Commands">
      <div class="slash-scroll">
        {groups.length === 0 && <div class="slash-empty">No matching commands</div>}
        {groups.map((g) => (
          <div class="slash-group" key={g.source} data-testid="slash-group" data-source={g.source}>
            <div class="slash-head">{SOURCE_LABEL[g.source]}</div>
            {g.items.map((c) => {
              const on = c.name === activeName;
              return (
                <button
                  key={c.name}
                  type="button"
                  aria-current={on}
                  class={`slash-item ${on ? 'on' : ''}`}
                  data-testid="slash-item"
                  data-command={c.name}
                  // Keep the keyboard up: the textarea must not lose focus.
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => onPick(c)}
                >
                  <span class="slash-name">
                    /{c.name}
                    {c.argumentHint && <span class="slash-args"> {c.argumentHint}</span>}
                  </span>
                  {c.description && <span class="slash-desc">{c.description}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </GlassSurface>
  );
}

/**
 * The composer, for a new chat (no `session`: the bar's pickers set it up and
 * the first send creates it) and for a running one (model and mode change in
 * place). Photos: pick, take or paste several, downscaled on the phone.
 */
export function Composer({
  session,
  onSent,
  text,
  setText,
}: {
  session?: SessionInfo;
  onSent: () => void;
  text: string;
  setText: (v: string) => void;
}): JSX.Element {
  const key = session?.id ?? NEW;
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const [browse, setBrowse] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const saveTimerRef = useRef<number | undefined>(undefined);
  const keyRef = useRef(key);

  // Another chat: its own draft (the textarea stays, so the keyboard does too).
  useEffect(() => {
    if (keyRef.current === key) return;
    clearTimeout(saveTimerRef.current);
    keyRef.current = key;
    setText(loadDraft(key));
    setAtts([]);
    setBrowse(false);
  }, [key, setText]);

  const d = draft.value;
  const isDraft = !session;
  const harnessReady = isDraft ? (d.info?.available ?? false) : true;
  const running = session?.status === 'running';
  // Stop also clears a pending approval or question (the agent may ask outside a running turn).
  const stoppable = running || session?.status === 'waiting';
  const sending = isDraft && starting.value?.status === 'sending';
  const canSend = harnessReady && !sending && (text.trim().length > 0 || atts.length > 0);

  // Commands: the session's own list, else what the agent offers before one exists.
  const fromSession = session ? sessionCommands(session.id).value : null;
  const commands =
    (fromSession?.length ? fromSession : null) ??
    (isDraft ? d.info?.commands : agentInfo(session.agent ?? 'claude')?.commands) ??
    [];
  const token = slashToken(text);
  const paletteOpen = commands.length > 0 && (token !== null || browse);
  const groups = paletteOpen ? groupCommands(commands, token ?? '') : [];
  const flat = groups.flatMap((g) => g.items);

  useEffect(() => setActive(0), [token]);
  useEffect(() => {
    if (paletteOpen && session) sessionCommands(session.id, true);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- refetch per session id, not per session update
  }, [paletteOpen, session?.id]);

  // Auto-grow: measure once per change, one style write.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = '0px';
    const h = Math.min(MAX_ROWS_PX, el.scrollHeight);
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > MAX_ROWS_PX ? 'auto' : 'hidden';
  }, [text]);

  useEffect(() => () => clearTimeout(saveTimerRef.current), []);

  const onInput = (v: string): void => {
    setText(v);
    clearTimeout(saveTimerRef.current);
    const k = key;
    saveTimerRef.current = window.setTimeout(() => saveDraft(k, v), 300);
  };

  const pick = (c: SlashCommand): void => {
    haptic('light');
    const rest = token !== null ? '' : text.replace(/^\/\S*\s*/, '');
    onInput(`/${c.name} ${rest}`);
    setBrowse(false);
    taRef.current?.focus();
  };

  const send = (): void => {
    if (!canSend) return;
    haptic('light');
    const body = text.trim();
    if (session) void client.sendChat(session.id, body, atts);
    else void startChat(body, atts);
    clearTimeout(saveTimerRef.current);
    setText('');
    setAtts([]);
    setBrowse(false);
    saveDraft(key, '');
    onSent();
  };

  const stop = (): void => {
    if (!session) return;
    haptic('medium');
    client.send({ t: 'chat.interrupt', sessionId: session.id });
  };

  const addPhotos = async (files: File[]): Promise<void> => {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;
    if (atts.length + images.length > MAX_PHOTOS) toast(`Up to ${MAX_PHOTOS} photos per message`, 'info');
    setBusy(true);
    try {
      const out = await Promise.all(images.slice(0, MAX_PHOTOS).map((f) => downscaleImage(f)));
      setAtts((a) => [...a, ...out].slice(0, MAX_PHOTOS));
    } catch {
      toast('Could not read that image', 'warn');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const placeholder = isDraft
    ? harnessReady
      ? `Message ${agentShortLabel({ agent: d.harness }, host.value)}`
      : `Set up ${d.info?.name ?? 'an agent'} to chat`
    : running
      ? 'Add to the queue…'
      : `Message ${agentShortLabel(session, host.value)}`;

  return (
    <>
      {paletteOpen && <Palette groups={groups} active={active} onPick={pick} />}
      <GlassSurface class="composer" data-testid="composer" data-draft={isDraft}>
        {atts.length > 0 && (
          <div class="composer-atts">
            {atts.map((a, i) => (
              <div class="att" key={a.data.slice(-32)} data-testid="composer-att">
                <img src={`data:${a.mediaType};base64,${a.data}`} alt={a.name ?? 'Attached photo'} />
                <button
                  type="button"
                  class="att-x"
                  aria-label="Remove photo"
                  data-testid="att-remove"
                  onClick={() => setAtts(atts.filter((_, j) => j !== i))}
                >
                  <Icon name="close" size={12} stroke={3} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div class="composer-main">
          <button
            type="button"
            class="c-btn"
            aria-label="Add photos"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            data-testid="composer-attach"
          >
            <Icon name={busy ? 'refresh' : 'plus'} size={22} stroke={2.1} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => void addPhotos([...(e.currentTarget.files ?? [])])}
            data-testid="composer-file"
          />
          <textarea
            ref={taRef}
            class="composer-input"
            rows={1}
            value={text}
            placeholder={placeholder}
            aria-label="Message"
            enterkeyhint="send"
            autocapitalize="sentences"
            data-testid="composer-input"
            onInput={(e) => onInput(e.currentTarget.value)}
            onPaste={(e) => {
              const files = [...(e.clipboardData?.files ?? [])];
              if (files.some((f) => f.type.startsWith('image/'))) {
                e.preventDefault();
                void addPhotos(files);
              }
            }}
            onKeyDown={(e) => {
              if (paletteOpen && flat.length) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : flat.length - 1)) % flat.length);
                  return;
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && token !== null)) {
                  const c = flat[active];
                  if (c) {
                    e.preventDefault();
                    pick(c);
                    return;
                  }
                }
              }
              if (e.key === 'Escape' && browse) setBrowse(false);
              // Desktop: Enter sends, Shift+Enter is a newline. On touch keyboards Return is a newline.
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.isComposing &&
                matchMedia('(pointer: fine)').matches
              ) {
                e.preventDefault();
                send();
              }
            }}
          />
          {stoppable && !canSend ? (
            <button
              type="button"
              class="send-btn stop"
              aria-label="Stop"
              onClick={stop}
              data-testid="composer-stop"
            >
              <span class="stop-square" />
            </button>
          ) : (
            <button
              type="button"
              class="send-btn"
              aria-label="Send"
              disabled={!canSend}
              onClick={send}
              data-testid="composer-send"
            >
              <Icon name="send" size={20} stroke={2.6} />
            </button>
          )}
        </div>
        <div class="composer-bar pickers" data-testid="composer-pickers">
          {commands.length > 0 && (
            <button
              type="button"
              class={`chip slash-chip ${paletteOpen ? 'on' : ''}`}
              aria-label="Commands"
              aria-expanded={paletteOpen}
              data-testid="composer-slash"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => {
                haptic('light');
                if (!text) onInput('/');
                else setBrowse(!browse);
                taRef.current?.focus();
              }}
            >
              <Icon name="slash" size={15} stroke={2.6} />
            </button>
          )}
          <HarnessChip session={session} onSwitch={() => saveDraft(NEW, text)} />
          {session?.kind !== 'terminal' && <ModelChip session={session} />}
          <ModeChip session={session} />
          {isDraft && <FolderChip />}
        </div>
      </GlassSurface>
    </>
  );
}
