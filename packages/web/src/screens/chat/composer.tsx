import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Attachment, PermissionMode, SessionInfo } from '@phone-code/protocol';
import { CLASSIC_MODES, agentShortLabel, currentModel, modelLabel, sessionModels } from '../../lib/agents';
import { client } from '../../lib/client';
import { downscaleImage } from '../../lib/image';
import { host } from '../../lib/state';
import { loadDraft, saveDraft } from '../../lib/storage';
import { haptic } from '../../lib/util';
import { GlassSurface } from '../../ui/glass';
import { Icon, type IconName } from '../../ui/icons';
import { openMenu, toast } from '../../ui/overlay';

export const MODES: Array<{
  mode: PermissionMode;
  label: string;
  short: string;
  icon: IconName;
  hint: string;
}> = [
  {
    mode: 'default',
    label: 'Ask before acting',
    short: 'Ask',
    icon: 'shield',
    hint: 'Approve edits and commands',
  },
  {
    mode: 'acceptEdits',
    label: 'Accept edits',
    short: 'Edits',
    icon: 'pencil',
    hint: 'Edits apply, commands still ask',
  },
  { mode: 'plan', label: 'Plan only', short: 'Plan', icon: 'list', hint: 'Read and plan, change nothing' },
  {
    mode: 'auto',
    label: 'Auto',
    short: 'Auto',
    icon: 'shieldAuto',
    hint: 'Claude approves safe actions, asks for risky ones',
  },
  {
    mode: 'bypassPermissions',
    label: 'Bypass permissions',
    short: 'Bypass',
    icon: 'bolt',
    hint: 'Never ask. Use with care',
  },
];

const DEFAULT_MODE = {
  mode: 'default',
  label: 'Ask before acting',
  short: 'Ask',
  icon: 'shield',
  hint: 'Approve edits and commands',
} as const;

export function modeInfo(m: PermissionMode | undefined): (typeof MODES)[number] {
  return MODES.find((x) => x.mode === m) ?? DEFAULT_MODE;
}

const MAX_ROWS_PX = 168;

export function Composer({ session, onSent }: { session: SessionInfo; onSent: () => void }): JSX.Element {
  const [text, setText] = useState(() => loadDraft(session.id));
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const saveTimerRef = useRef<number | undefined>(undefined);
  const running = session.status === 'running';
  // Stop also clears a pending approval or question (the agent may ask outside a running turn).
  const stoppable = running || session.status === 'waiting';
  const canSend = text.trim().length > 0 || atts.length > 0;

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
    saveTimerRef.current = window.setTimeout(() => saveDraft(session.id, v), 300);
  };

  const send = (): void => {
    if (!canSend) return;
    haptic('light');
    const body = text.trim();
    void client.sendChat(session.id, body, atts);
    setText('');
    setAtts([]);
    saveDraft(session.id, '');
    onSent();
  };

  const stop = (): void => {
    haptic('medium');
    client.send({ t: 'chat.interrupt', sessionId: session.id });
  };

  const pickPhotos = async (files: FileList | null): Promise<void> => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const out = await Promise.all([...files].slice(0, 4).map((f) => downscaleImage(f)));
      setAtts((a) => [...a, ...out].slice(0, 4));
    } catch {
      toast('Could not read that image', 'warn');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const mode = modeInfo(session.permissionMode);
  // Agents report their models (with names) per session; before that, the host's list.
  const models = sessionModels(session, host.value);
  const current = currentModel(session.model, models);
  const offered = session.permissionModes ?? CLASSIC_MODES;
  const modes = MODES.filter((m) => offered.includes(m.mode));

  return (
    <GlassSurface class="composer" data-testid="composer">
      {atts.length > 0 && (
        <div class="composer-atts">
          {atts.map((a, i) => (
            <div class="att" key={a.data.slice(-32)}>
              <img src={`data:${a.mediaType};base64,${a.data}`} alt={a.name ?? 'Attached photo'} />
              <button
                type="button"
                class="att-x"
                aria-label="Remove photo"
                onClick={() => setAtts(atts.filter((_, j) => j !== i))}
              >
                <Icon name="close" size={12} stroke={3} />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        class="composer-input"
        rows={1}
        value={text}
        placeholder={running ? 'Add to the queue…' : `Message ${agentShortLabel(session, host.value)}`}
        aria-label="Message"
        enterkeyhint="send"
        autocapitalize="sentences"
        data-testid="composer-input"
        onInput={(e) => onInput(e.currentTarget.value)}
        onKeyDown={(e) => {
          // Desktop: Enter sends, Shift+Enter is a newline. On touch keyboards Return is a newline.
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div class="composer-bar">
        <button
          type="button"
          class="c-btn"
          aria-label="Attach photo"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          data-testid="composer-attach"
        >
          <Icon name={busy ? 'refresh' : 'photo'} size={21} stroke={1.9} />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => void pickPhotos(e.currentTarget.files)}
          data-testid="composer-file"
        />
        <button
          type="button"
          class={`chip mode-${session.permissionMode ?? 'default'}`}
          data-testid="composer-mode"
          onClick={(e) =>
            openMenu(
              e.currentTarget,
              [
                {
                  title: 'Permissions',
                  items: modes.map((m) => ({
                    label: m.label,
                    hint: m.hint,
                    icon: m.icon,
                    checked: m.mode === (session.permissionMode ?? 'default'),
                    destructive: m.mode === 'bypassPermissions',
                    testid: `mode-${m.mode}`,
                    onSelect: () =>
                      client.send({ t: 'chat.setMode', sessionId: session.id, permissionMode: m.mode }),
                  })),
                },
              ],
              { testid: 'mode-menu' },
            )
          }
        >
          <Icon name={mode.icon} size={14} stroke={2.3} />
          {mode.short}
        </button>
        {models.length > 0 && (
          <button
            type="button"
            class="chip"
            data-testid="composer-model"
            onClick={(e) =>
              openMenu(
                e.currentTarget,
                [
                  {
                    title: 'Model',
                    items: models.map((m) => ({
                      label: m.name ?? m.id,
                      ...(m.description ? { hint: m.description } : {}),
                      checked: m.id === current?.id,
                      testid: `model-${m.id}`,
                      onSelect: () => client.send({ t: 'chat.setModel', sessionId: session.id, model: m.id }),
                    })),
                  },
                ],
                { testid: 'model-menu' },
              )
            }
          >
            <span class="chip-text">{modelLabel(session.model, models) ?? 'Model'}</span>
            <Icon name="down" size={12} stroke={2.6} />
          </button>
        )}
        <span class="composer-spacer" />
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
    </GlassSurface>
  );
}
