import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Attachment, SessionInfo, SlashCommand } from '@phone-code/protocol';
import { agentShortLabel, isCursorChat } from '../../lib/agents';
import { client } from '../../lib/client';
import { groupCommands, sessionCommands, SOURCE_LABEL } from '../../lib/commands';
import { agentInfo, draft, startChat, starting } from '../../lib/harness';
import { downscaleImage } from '../../lib/image';
import { chatOf, host } from '../../lib/state';
import { loadDraft, saveDraft } from '../../lib/storage';
import { haptic } from '../../lib/util';
import { GlassSurface } from '../../ui/glass';
import { Icon } from '../../ui/icons';
import { toast } from '../../ui/overlay';
import { EffortChip, FolderChip, HarnessChip, ModeChip, ModelChip } from './pickers';

export { MODES, modeInfo } from './pickers';

const MAX_ROWS_PX = 168;
const MAX_FILES = 6;
/** The largest file that is not a photo (photos are downscaled first). */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
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

/** Placeholder until the composer's own handler is in place. */
const addFilesLater = (_files: File[]): void => {};

/** A file as it is (not a photo): its bytes in base64, its name and type. */
function readAttachment(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('error', () => reject(new Error('unreadable')));
    reader.addEventListener('load', () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      resolve({
        mediaType: file.type || 'application/octet-stream',
        name: file.name,
        data: url.slice(url.indexOf(',') + 1),
      });
    });
    reader.readAsDataURL(file);
  });
}

/** 35900 -> "36k", 1000000 -> "1.0M". */
const shortCount = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

/**
 * How full the model's context is, as of the last turn that said: a small ring
 * and a percentage, the token counts on hover.
 */
function ContextRing({ sessionId }: { sessionId: string }): JSX.Element | null {
  const chat = chatOf(sessionId);
  const ids = chat.ids.value;
  let used = 0;
  let size = 0;
  for (let i = ids.length - 1; i >= 0 && size === 0; i--) {
    const item = chat.items.get(ids[i] ?? '')?.value;
    if (item?.kind === 'turn' && item.contextTokens && item.contextWindow) {
      used = item.contextTokens;
      size = item.contextWindow;
    }
  }
  // Pointing at the ring names the tokens; a click keeps them shown (and is the way on a touch screen).
  const [pinned, setPinned] = useState(false);
  const [over, setOver] = useState(false);
  if (size === 0) return null;
  const fraction = Math.min(1, used / size);
  const pct = Math.round(fraction * 100);
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <button
      type="button"
      class={`context-ring ${fraction >= 0.9 ? 'full' : fraction >= 0.75 ? 'warn' : ''} ${pinned || over ? 'tokens' : ''}`}
      aria-pressed={pinned}
      onClick={() => setPinned(!pinned)}
      onMouseEnter={() => setOver(true)}
      onMouseLeave={() => setOver(false)}
      title={`${shortCount(used)} of ${shortCount(size)} tokens`}
      aria-label={`Context ${pct}% used: ${shortCount(used)} of ${shortCount(size)} tokens`}
      data-testid="context-ring"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle class="ring-track" cx="8" cy="8" r={r} fill="none" stroke-width="2.5" />
        <circle
          class="ring-fill"
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-dasharray={c}
          stroke-dashoffset={c * (1 - Math.max(0.03, fraction))}
        />
      </svg>
      <span class="ring-pct">{pct}%</span>
      <span class="ring-tokens" data-testid="context-tokens">
        {shortCount(used)} / {shortCount(size)}
      </span>
    </button>
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

  // Another chat: its own draft (the textarea stays, so the keyboard does too). Before the
  // next paint: typing that starts right after the switch is not wiped by a late reset.
  useLayoutEffect(() => {
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
  // A Cursor chat waits for a reply, not an approval: nothing to stop then.
  const stoppable = running || (session?.status === 'waiting' && !isCursorChat(session));
  const sending = isDraft && starting.value?.status === 'sending';
  // Cursor's app takes a message only when a turn ends: while it works (sent at the
  // end) or while it waits for a reply. Otherwise there is no way to hand it one.
  const cursor = isCursorChat(session);
  const closed = cursor && !running && session?.status !== 'waiting';
  const canSend = harnessReady && !sending && !closed && (text.trim().length > 0 || atts.length > 0);

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

  // Files dropped anywhere on the page go to the message (and never replace the page).
  const addFilesRef = useRef(addFilesLater);
  useLayoutEffect(() => {
    addFilesRef.current = (files) => void addFiles(files);
  });
  useEffect(() => {
    const hasFiles = (e: DragEvent): boolean => e.dataTransfer?.types.includes('Files') === true;
    const over = (e: DragEvent): void => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      // Several chats side by side: the one the files were dropped on (else the focused one).
      const mine = taRef.current?.closest('.pane');
      const hit = e.target instanceof Element ? e.target.closest('.pane') : null;
      if (mine && mine !== (hit ?? document.querySelector('.pane.focused'))) return;
      addFilesRef.current([...(e.dataTransfer?.files ?? [])]);
    };
    addEventListener('dragover', over);
    addEventListener('drop', drop);
    return () => {
      removeEventListener('dragover', over);
      removeEventListener('drop', drop);
    };
  }, []);

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

  /** Photos (downscaled here) and any other file (as it is), picked, pasted or dropped. */
  const addFiles = async (files: File[]): Promise<void> => {
    if (!files.length) return;
    if (atts.length + files.length > MAX_FILES) toast(`Up to ${MAX_FILES} files per message`, 'info');
    const room = files.slice(0, Math.max(0, MAX_FILES - atts.length));
    const fits = room.filter((f) => f.type.startsWith('image/') || f.size <= MAX_FILE_BYTES);
    if (fits.length < room.length) toast('Files up to 10 MB', 'warn');
    if (!fits.length) return;
    setBusy(true);
    try {
      const out = await Promise.all(
        fits.map((f) => (f.type.startsWith('image/') ? downscaleImage(f) : readAttachment(f))),
      );
      setAtts((a) => [...a, ...out].slice(0, MAX_FILES));
    } catch {
      toast('Could not read that file', 'warn');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const placeholder = isDraft
    ? harnessReady
      ? `Message ${agentShortLabel({ agent: d.harness }, host.value)}`
      : `Set up ${d.info?.name ?? 'an agent'} to chat`
    : closed
      ? 'Continue this chat in Cursor'
      : running
        ? cursor
          ? 'Send when this turn ends…'
          : 'Add to the queue…'
        : cursor
          ? 'Reply to Cursor'
          : `Message ${agentShortLabel(session, host.value)}`;

  return (
    <>
      {paletteOpen && <Palette groups={groups} active={active} onPick={pick} />}
      <GlassSurface class="composer" data-testid="composer" data-draft={isDraft}>
        {atts.length > 0 && (
          <div class="composer-atts">
            {atts.map((a, i) => (
              <div
                class={`att ${a.mediaType.startsWith('image/') ? '' : 'att-file'}`}
                key={`${a.name ?? ''}:${a.data.length}:${a.data.slice(-24)}`}
                data-testid="composer-att"
              >
                {a.mediaType.startsWith('image/') ? (
                  <img src={`data:${a.mediaType};base64,${a.data}`} alt={a.name ?? 'Attached photo'} />
                ) : (
                  <span class="att-file-body">
                    <Icon name="doc" size={16} stroke={2} />
                    <span class="att-file-name">{a.name ?? 'File'}</span>
                  </span>
                )}
                <button
                  type="button"
                  class="att-x"
                  aria-label="Remove"
                  data-testid="att-remove"
                  onClick={() => setAtts(atts.filter((_, j) => j !== i))}
                >
                  <Icon name="close" size={12} stroke={3} />
                </button>
              </div>
            ))}
          </div>
        )}
        {closed && (
          <p class="composer-note" data-testid="composer-closed">
            Cursor is no longer waiting for a reply here. Send its next message from Cursor on your computer;
            when that turn ends you can reply from here again.
          </p>
        )}
        <div class="composer-main">
          <button
            type="button"
            class="c-btn"
            aria-label="Add photos or files"
            onClick={() => fileRef.current?.click()}
            disabled={busy || closed}
            data-testid="composer-attach"
          >
            <Icon name={busy ? 'refresh' : 'plus'} size={18} stroke={2.3} />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => void addFiles([...(e.currentTarget.files ?? [])])}
            data-testid="composer-file"
          />
          <textarea
            ref={taRef}
            class="composer-input"
            rows={1}
            value={text}
            disabled={closed}
            placeholder={placeholder}
            aria-label="Message"
            enterkeyhint="send"
            autocapitalize="sentences"
            data-testid="composer-input"
            onInput={(e) => onInput(e.currentTarget.value)}
            onPaste={(e) => {
              const files = [...(e.clipboardData?.files ?? [])];
              if (files.length > 0) {
                e.preventDefault();
                void addFiles(files);
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
              <Icon name="send" size={17} stroke={2.6} />
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
              <Icon name="slash" size={13} stroke={2.4} />
            </button>
          )}
          <HarnessChip session={session} onSwitch={() => saveDraft(NEW, text)} />
          {session?.kind !== 'terminal' && <ModelChip session={session} />}
          <EffortChip session={session} />
          <ModeChip session={session} />
          {isDraft && <FolderChip />}
          {session && <ContextRing sessionId={session.id} />}
        </div>
      </GlassSurface>
    </>
  );
}
