import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import type { SessionInfo } from '@phone-code/protocol';
import { archiveSession, copyLastResponse, deleteSession, renameSession } from '../lib/actions';
import { ALT, MOD, SHIFT, isTyping, keyOf, plain, withMod } from '../lib/keys';
import { MAX_PANES, closePane, focusPane, focused, openBeside, openNew, panes, route } from '../lib/nav';
import { sessions } from '../lib/state';
import { closeDrawer, openDrawer, toggleSidebar, wide } from '../ui/drawer';
import { GlassButton } from '../ui/glass';
import { openSheet, overlayOpen } from '../ui/overlay';
import { openComputer } from './sidebar';

/**
 * Keyboard shortcuts: one table, read both by the key handler and by the list the
 * app shows (⌘/). What a shortcut does in "the chat" is done to the focused tile, by
 * pressing its own control, so a key and a click behave the same. The Mac app's menu
 * runs the same commands (`window.phonecodeCommand`, see Mac/WebShell.swift).
 */

type Group = 'General' | 'Chats' | 'In a chat' | 'Tiles' | 'Approvals and questions' | 'Lists and menus';

interface Shortcut {
  group: Group;
  /** How it reads in the list, e.g. ['⌘', 'K']. */
  keys: string[];
  label: string;
  /** The command it runs (also reachable from the Mac app's menu). */
  command?: Command;
  /** Whether this key press is it. Absent: only listed (handled where it applies). */
  match?: (e: KeyboardEvent) => boolean;
  /** Also while typing in a field (keys with ⌘ are; bare keys are text). */
  whileTyping?: boolean;
}

// ------------------------------------------------------------ commands

/** Where "the chat" is: the focused tile, else the page. */
function paneRoot(): ParentNode {
  return document.querySelector('.pane.focused') ?? document;
}

/** Presses a control of the focused tile by its test id; false when it is not there. */
function press(testid: string): boolean {
  const el = paneRoot().querySelector<HTMLElement>(`[data-testid="${testid}"]`);
  if (!el || el.hasAttribute('disabled') || el.offsetParent === null) return false;
  el.click();
  return true;
}

function currentSession(): SessionInfo | undefined {
  const r = route.peek();
  return r.name === 'session' ? sessions.peek().find((s) => s.id === r.id) : undefined;
}

/** The chats in the order the sidebar lists them. */
function sidebarIds(): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>('[data-testid="sidebar-list"] [data-testid="session-row"]'),
  ]
    .map((el) => el.dataset['sessionId'])
    .filter((id): id is string => id !== undefined);
}

function openListed(id: string | undefined): void {
  if (id === undefined) return;
  document
    .querySelector<HTMLElement>(`[data-testid="sidebar-list"] [data-session-id="${CSS.escape(id)}"]`)
    ?.click();
}

function stepChat(by: 1 | -1): void {
  const ids = sidebarIds();
  if (ids.length === 0) return;
  const cur = currentSession()?.id;
  const at = cur === undefined ? -1 : ids.indexOf(cur);
  openListed(ids[at < 0 ? (by > 0 ? 0 : ids.length - 1) : (at + by + ids.length) % ids.length]);
}

function focusComposer(): void {
  closeDrawer();
  const el = paneRoot().querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]');
  el?.focus();
}

function focusSearch(): void {
  if (!wide.peek()) openDrawer();
  const el = document.querySelector<HTMLInputElement>('[data-testid="search-input"]');
  el?.focus();
  el?.select();
}

function stepTile(by: 1 | -1): void {
  const list = panes.peek();
  if (list.length < 2) return;
  const next = list[(focused.peek() + by + list.length) % list.length];
  if (next) focusPane(next.k);
  // The new tile's message box, ready to type.
  requestAnimationFrame(focusComposer);
}

/** The bar's pickers, in their order: agent, model, thinking level, permissions, folder. */
const PICKERS = ['composer-harness', 'composer-model', 'composer-effort', 'composer-mode', 'composer-folder'];

export const COMMANDS = {
  newChat: (): void => {
    openNew();
    closeDrawer();
    requestAnimationFrame(focusComposer);
  },
  search: focusSearch,
  shortcuts: (): void => openShortcuts(),
  toggleSidebar,
  thisComputer: (): void => openComputer(),
  previousChat: (): void => stepChat(-1),
  nextChat: (): void => stepChat(1),
  rename: (): void => {
    const s = currentSession();
    if (s) void renameSession(s);
  },
  archive: (): void => {
    const s = currentSession();
    if (s) void archiveSession(s);
  },
  delete: (): void => {
    const s = currentSession();
    if (s) void deleteSession(s);
  },
  copyLastResponse: (): void => {
    const s = currentSession();
    if (s) void copyLastResponse(s.id);
  },
  focusComposer,
  stop: (): void => {
    press('composer-stop');
  },
  attach: (): void => {
    press('composer-attach');
  },
  newChatBeside: (): void => {
    if (wide.peek() && panes.peek().length < MAX_PANES) openBeside({ name: 'new' });
  },
  closeTile: (): void => {
    const p = panes.peek()[focused.peek()];
    if (wide.peek() && p && panes.peek().length > 1) closePane(p.k);
  },
  previousTile: (): void => stepTile(-1),
  nextTile: (): void => stepTile(1),
} as const;

export type Command = keyof typeof COMMANDS;

const isCommand = (name: string): name is Command => Object.hasOwn(COMMANDS, name);

/** Runs a command by name (the Mac app's menu calls this). */
export function runCommand(name: string): void {
  if (isCommand(name)) COMMANDS[name]();
}

declare global {
  interface Window {
    /** For the Mac app's menu (Mac/WebShell.swift). */
    phonecodeCommand?: (name: string) => void;
  }
}

// ------------------------------------------------------------ approvals

/** The pending approval's buttons in the order they are numbered: Allow, Always allow, Deny. */
export function approvalButtons(card: ParentNode): HTMLElement[] {
  return ['permission-allow', 'permission-allow-always', 'permission-deny']
    .map((id) => card.querySelector<HTMLElement>(`[data-testid="${id}"]`))
    .filter((b): b is HTMLElement => b !== null);
}

/** 1, 2, 3…: answers the approval or the question waiting in the focused tile. */
function answerByNumber(n: number): boolean {
  const root = paneRoot();
  const perm = [
    ...root.querySelectorAll<HTMLElement>('[data-testid="chat-item-permission"][data-status="pending"]'),
  ].at(-1);
  if (perm) {
    const b = approvalButtons(perm)[n - 1];
    b?.click();
    return b !== undefined;
  }
  const q = [
    ...root.querySelectorAll<HTMLElement>('[data-testid="chat-item-question"][data-status="pending"]'),
  ].at(-1);
  if (q) {
    const opt = [...q.querySelectorAll<HTMLElement>('[data-testid="question-option"]')][n - 1];
    opt?.click();
    return opt !== undefined;
  }
  return false;
}

// ------------------------------------------------------------ the table

const key = (e: KeyboardEvent, k: string): boolean => keyOf(e).toLowerCase() === k;

export const SHORTCUTS: Shortcut[] = [
  {
    group: 'General',
    keys: [MOD, 'N'],
    label: 'New chat',
    command: 'newChat',
    match: (e) => withMod(e) && key(e, 'n'),
    whileTyping: true,
  },
  {
    group: 'General',
    keys: [MOD, 'K'],
    label: 'Search all chats',
    command: 'search',
    match: (e) => withMod(e) && key(e, 'k'),
    whileTyping: true,
  },
  {
    group: 'General',
    keys: [MOD, 'B'],
    label: 'Show or hide the chats',
    command: 'toggleSidebar',
    match: (e) => withMod(e) && key(e, 'b'),
    whileTyping: true,
  },
  {
    group: 'General',
    keys: [MOD, ','],
    label: 'This computer',
    command: 'thisComputer',
    match: (e) => withMod(e) && e.key === ',',
    whileTyping: true,
  },
  {
    group: 'General',
    keys: [MOD, '/'],
    label: 'Keyboard shortcuts',
    command: 'shortcuts',
    match: (e) => withMod(e) && (e.key === '/' || e.code === 'Slash'),
    whileTyping: true,
  },

  {
    group: 'Chats',
    keys: [ALT, '↑'],
    label: 'Previous chat',
    command: 'previousChat',
    match: (e) => e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowUp',
    whileTyping: true,
  },
  {
    group: 'Chats',
    keys: [ALT, '↓'],
    label: 'Next chat',
    command: 'nextChat',
    match: (e) => e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowDown',
    whileTyping: true,
  },
  { group: 'Chats', keys: [MOD, '1–9'], label: 'Chat 1 to 9 in the list' },
  {
    group: 'Chats',
    keys: [MOD, SHIFT, 'R'],
    label: 'Rename the chat',
    command: 'rename',
    match: (e) => (withMod(e, { shift: true }) && key(e, 'r')) || (plain(e) && e.key === 'F2'),
    whileTyping: true,
  },
  {
    group: 'Chats',
    keys: [MOD, SHIFT, 'A'],
    label: 'Archive the chat',
    command: 'archive',
    match: (e) => withMod(e, { shift: true }) && key(e, 'a'),
    whileTyping: true,
  },
  {
    group: 'Chats',
    keys: [MOD, '⌫'],
    label: 'Delete the chat',
    command: 'delete',
    match: (e) => withMod(e) && e.key === 'Backspace',
  },
  {
    group: 'Chats',
    keys: [MOD, SHIFT, 'C'],
    label: 'Copy the last response',
    command: 'copyLastResponse',
    match: (e) => withMod(e, { shift: true }) && key(e, 'c'),
    whileTyping: true,
  },

  {
    group: 'In a chat',
    keys: [MOD, 'L'],
    label: 'Go to the message box',
    command: 'focusComposer',
    match: (e) => withMod(e) && key(e, 'l'),
    whileTyping: true,
  },
  { group: 'In a chat', keys: ['⏎'], label: 'Send (⇧⏎ for a new line)' },
  {
    group: 'In a chat',
    keys: [MOD, '.'],
    label: 'Stop the agent',
    command: 'stop',
    match: (e) => withMod(e) && e.key === '.',
    whileTyping: true,
  },
  {
    group: 'In a chat',
    keys: [MOD, 'O'],
    label: 'Attach photos or files',
    command: 'attach',
    match: (e) => withMod(e) && key(e, 'o'),
    whileTyping: true,
  },
  { group: 'In a chat', keys: ['/'], label: 'Commands, in the message box' },
  { group: 'In a chat', keys: [ALT, MOD, '1–5'], label: 'Agent, model, thinking, permissions, folder' },
  { group: 'In a chat', keys: ['esc'], label: 'Leave the message box' },

  {
    group: 'Tiles',
    keys: [MOD, 'D'],
    label: 'New chat beside this one',
    command: 'newChatBeside',
    match: (e) => withMod(e) && key(e, 'd'),
    whileTyping: true,
  },
  {
    group: 'Tiles',
    keys: [ALT, MOD, 'W'],
    label: 'Close this tile',
    command: 'closeTile',
    match: (e) => withMod(e, { alt: true }) && key(e, 'w'),
    whileTyping: true,
  },
  {
    group: 'Tiles',
    keys: [ALT, MOD, '←'],
    label: 'Previous tile',
    command: 'previousTile',
    match: (e) => withMod(e, { alt: true }) && e.key === 'ArrowLeft',
    whileTyping: true,
  },
  {
    group: 'Tiles',
    keys: [ALT, MOD, '→'],
    label: 'Next tile',
    command: 'nextTile',
    match: (e) => withMod(e, { alt: true }) && e.key === 'ArrowRight',
    whileTyping: true,
  },

  {
    group: 'Approvals and questions',
    keys: ['1', '2', '3'],
    label: 'Allow, Always allow, Deny (as numbered)',
  },
  { group: 'Approvals and questions', keys: ['1–9'], label: 'Choose an answer to a question' },

  { group: 'Lists and menus', keys: ['↑', '↓'], label: 'Move between chats, items and options' },
  { group: 'Lists and menus', keys: ['⏎'], label: 'Open or choose' },
  { group: 'Lists and menus', keys: [MOD, '⏎'], label: 'Open a chat beside this one' },
  { group: 'Lists and menus', keys: [SHIFT, 'F10'], label: "A chat's actions (or the menu key)" },
  { group: 'Lists and menus', keys: ['tab'], label: 'Next control (⇧tab: previous)' },
  { group: 'Lists and menus', keys: ['esc'], label: 'Close' },
];

// ------------------------------------------------------------ handler

function onKey(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing) return;
  // A sheet, menu or dialog has the keyboard (it handles Escape and Tab itself).
  if (overlayOpen()) return;
  const typing = isTyping(e);
  for (const s of SHORTCUTS) {
    if (!s.command || !s.match || (typing && !s.whileTyping) || !s.match(e)) continue;
    e.preventDefault();
    COMMANDS[s.command]();
    return;
  }
  const digit = keyOf(e);
  // ⌘1–9: that chat in the list.
  if (withMod(e) && /^[1-9]$/.test(digit)) {
    e.preventDefault();
    openListed(sidebarIds()[Number(digit) - 1]);
    return;
  }
  // ⌥⌘1–5: the bar's pickers.
  if (withMod(e, { alt: true }) && /^[1-5]$/.test(digit)) {
    e.preventDefault();
    press(PICKERS[Number(digit) - 1] ?? '');
    return;
  }
  if (typing) {
    // Escape leaves the message box (its own uses of Escape come first).
    if (
      e.key === 'Escape' &&
      e.target instanceof HTMLElement &&
      e.target.matches('[data-testid="composer-input"]')
    )
      e.target.blur();
    return;
  }
  // 1, 2, 3…: the approval or question waiting in the chat.
  if (plain(e) && /^[1-9]$/.test(e.key) && answerByNumber(Number(e.key))) e.preventDefault();
}

/** Installs the shortcuts (once, at the app's root). */
export function useShortcuts(): void {
  useEffect(() => {
    addEventListener('keydown', onKey);
    window.phonecodeCommand = runCommand;
    return () => {
      removeEventListener('keydown', onKey);
      delete window.phonecodeCommand;
    };
  }, []);
}

// ------------------------------------------------------------ the list

const GROUPS: Group[] = [
  'General',
  'Chats',
  'In a chat',
  'Tiles',
  'Approvals and questions',
  'Lists and menus',
];

function Keys({ keys }: { keys: string[] }): JSX.Element {
  return (
    <span class="kbd-keys">
      {keys.map((k) => (
        <kbd key={k}>{k}</kbd>
      ))}
    </span>
  );
}

export function openShortcuts(): void {
  openSheet(
    (close) => (
      <>
        <div class="sheet-head">
          <span class="glass-btn ghost" aria-hidden="true" />
          <h2>Keyboard shortcuts</h2>
          <GlassButton icon="close" label="Close" iconSize={18} onClick={close} testid="shortcuts-close" />
        </div>
        <div class="sheet-scroll shortcuts" data-testid="shortcuts-list">
          {GROUPS.filter((g) => g !== 'Tiles' || wide.peek()).map((g) => (
            <section class="section" key={g}>
              <h3 class="section-head">{g}</h3>
              <dl class="shortcut-list">
                {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                  <div class="shortcut" key={s.label}>
                    <dt>{s.label}</dt>
                    <dd>
                      <Keys keys={s.keys} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </>
    ),
    { testid: 'shortcuts-sheet', label: 'Keyboard shortcuts', large: true },
  );
}
