import type { JSX } from 'preact';
import type { PermissionMode, SessionInfo } from '@phone-code/protocol';
import { CLASSIC_MODES, currentModel, modelLabel, modelOptions, sessionModels } from '../../lib/agents';
import { client } from '../../lib/client';
import {
  agentInfo,
  draft,
  harnessList,
  openTerminal,
  pickFolder,
  pickHarness,
  pickMode,
  pickModel,
  type Harness,
} from '../../lib/harness';
import { openNew } from '../../lib/nav';
import { host } from '../../lib/state';
import { setHarnessPrefs } from '../../lib/storage';
import { basename, copyText } from '../../lib/util';
import { Glyph, agentGlyph } from '../../ui/glyph';
import { Icon, type IconName } from '../../ui/icons';
import { lazy } from '../../ui/lazy';
import { alertDialog, openMenu, openSheet, toast } from '../../ui/overlay';

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

const SHORT: Record<string, string> = { claude: 'Claude', codex: 'Codex', terminal: 'Terminal' };

function harnessName(id: Harness): string {
  return id === 'terminal' ? 'Terminal' : (agentInfo(id)?.name ?? id);
}

function shortName(id: Harness): string {
  return SHORT[id] ?? harnessName(id);
}

/** The command in a setup hint, the part worth copying: `codex login`, or what follows "run:". */
function commandIn(hint: string): string | null {
  const tick = /`([^`]+)`/.exec(hint);
  if (tick?.[1]) return tick[1];
  return /\brun:?\s+(.+?)\.?$/i.exec(hint)?.[1]?.trim() ?? null;
}

async function explainSetup(id: Harness): Promise<void> {
  const hint = agentInfo(id)?.setupHint ?? 'It is not installed on this computer.';
  const cmd = commandIn(hint);
  const ok = await alertDialog({
    title: `Set up ${harnessName(id)}`,
    message: `${hint} Once it is set up, it shows up here as ready.`,
    confirm: cmd ? 'Copy command' : 'OK',
    cancel: 'Close',
    testid: 'setup-dialog',
  });
  if (ok && cmd && (await copyText(cmd))) toast('Copied', 'check');
}

/**
 * The harness picker is also the answer to "what can I use on this
 * computer": ready ones first, the rest dimmed with what to do about them.
 */
export function HarnessChip({
  session,
  onSwitch,
}: {
  session?: SessionInfo;
  /** A different harness in a chat with messages starts a new chat. */
  onSwitch?: () => void;
}): JSX.Element {
  const current: Harness = session
    ? session.kind === 'terminal'
      ? 'terminal'
      : (session.agent ?? 'claude')
    : draft.value.harness;
  const cwd = session?.cwd ?? draft.value.cwd;
  const list = harnessList();
  const choose = (id: Harness): void => {
    if (id === current) return;
    if (id === 'terminal') {
      void openTerminal(cwd);
      return;
    }
    pickHarness(id);
    if (session) {
      onSwitch?.();
      openNew();
    }
  };
  const item = (h: (typeof list)[number]): Parameters<typeof openMenu>[1][number]['items'][number] => ({
    label: harnessName(h.id),
    lead: <Glyph kind={h.id === 'terminal' ? 'terminal' : agentGlyph(h.id)} size={28} />,
    hint: h.info?.setupHint
      ? h.info.setupHint
      : h.available
        ? h.id === 'terminal'
          ? `Opens a shell in ${basename(cwd) || cwd}`
          : h.info?.version
            ? `v${h.info.version}`
            : 'Ready'
        : 'Not installed on this computer',
    checked: h.id === current,
    dim: !h.available,
    testid: `harness-${h.id}`,
    onSelect: () => (h.available ? choose(h.id) : void explainSetup(h.id)),
  });
  return (
    <button
      type="button"
      class="chip harness-chip"
      data-testid="composer-harness"
      data-harness={current}
      aria-label={`Harness: ${harnessName(current)}`}
      onClick={(e) =>
        openMenu(
          e.currentTarget,
          [
            {
              title: `On ${host.value?.name ?? 'this computer'}`,
              items: list.filter((h) => h.available).map(item),
            },
            { title: 'Not set up', items: list.filter((h) => !h.available).map(item) },
          ],
          { testid: 'harness-menu' },
        )
      }
    >
      <Glyph kind={current === 'terminal' ? 'terminal' : agentGlyph(current)} size={20} />
      <span class="chip-text">{shortName(current)}</span>
    </button>
  );
}

export function ModelChip({ session }: { session?: SessionInfo }): JSX.Element | null {
  const d = draft.value;
  const models = session ? sessionModels(session, host.value) : modelOptions(d.info);
  if (!models.length) return null;
  const model = session ? session.model : d.model;
  const current = currentModel(model, models);
  const harness = session ? (session.agent ?? 'claude') : d.harness;
  const set = (id: string): void => {
    const opt = models.find((m) => m.id === id);
    setHarnessPrefs(harness, { model: opt?.isDefault ? undefined : id });
    if (session) client.send({ t: 'chat.setModel', sessionId: session.id, model: id });
  };
  return (
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
              items: [
                // Before a session, "Default" sends no model: the agent's own default.
                ...(!session && !models.some((m) => m.isDefault)
                  ? [
                      {
                        label: 'Default',
                        checked: !model,
                        testid: 'model-default',
                        onSelect: () => pickModel(undefined),
                      },
                    ]
                  : []),
                ...models.map((m) => ({
                  label: m.name ?? m.id,
                  ...(m.description ? { hint: m.description } : {}),
                  checked: session ? m.id === current?.id : m.isDefault ? !model : m.id === model,
                  testid: `model-${m.id}`,
                  onSelect: () => set(m.id),
                })),
              ],
            },
          ],
          { testid: 'model-menu' },
        )
      }
    >
      <span class="chip-text">{modelLabel(model, models) ?? 'Default'}</span>
      <Icon name="down" size={12} stroke={2.6} />
    </button>
  );
}

export function ModeChip({ session }: { session?: SessionInfo }): JSX.Element | null {
  const d = draft.value;
  const offered = session ? (session.permissionModes ?? CLASSIC_MODES) : d.modes;
  if (!offered.length || session?.kind === 'terminal') return null;
  const value = session ? (session.permissionMode ?? 'default') : d.mode;
  const harness = session ? (session.agent ?? 'claude') : d.harness;
  const m = modeInfo(value);
  return (
    <button
      type="button"
      class={`chip mode-${value}`}
      data-testid="composer-mode"
      onClick={(e) =>
        openMenu(
          e.currentTarget,
          [
            {
              title: 'Permissions',
              items: MODES.filter((x) => offered.includes(x.mode)).map((x) => ({
                label: x.label,
                hint: x.hint,
                icon: x.icon,
                checked: x.mode === value,
                destructive: x.mode === 'bypassPermissions',
                testid: `mode-${x.mode}`,
                onSelect: () => {
                  if (session) {
                    setHarnessPrefs(harness, { mode: x.mode });
                    client.send({ t: 'chat.setMode', sessionId: session.id, permissionMode: x.mode });
                  } else pickMode(x.mode);
                },
              })),
            },
          ],
          { testid: 'mode-menu' },
        )
      }
    >
      <Icon name={m.icon} size={14} stroke={2.3} />
      {m.short}
    </button>
  );
}

const FolderSheet = lazy(() => import('../folder'));

export function openFolderPicker(start: string, onPick: (p: string) => void): void {
  void FolderSheet.preload();
  openSheet((close) => <FolderSheet start={start} onPick={onPick} close={close} />, {
    testid: 'folder-sheet',
    label: 'Choose folder',
    large: true,
  });
}

/** Where a new chat runs: the last folder used with this harness, else home. */
export function FolderChip(): JSX.Element {
  const d = draft.value;
  return (
    <button
      type="button"
      class="chip folder-chip"
      data-testid="composer-folder"
      title={d.cwd}
      onClick={() => openFolderPicker(d.cwd, (p) => pickFolder(p))}
    >
      <Icon name="folder" size={13} stroke={2.2} />
      <span class="chip-text">{d.cwd === host.value?.home ? '~' : basename(d.cwd) || d.cwd}</span>
    </button>
  );
}
