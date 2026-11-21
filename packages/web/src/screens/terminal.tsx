import type { JSX, TargetedMouseEvent } from 'preact';
import { useSignal, useSignalEffect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import '../styles/terminal.css';
import { archiveSession, deleteSession, renameSession } from '../lib/actions';
import { client } from '../lib/client';
import { host, sessionById } from '../lib/state';
import { settings, updateSettings } from '../lib/storage';
import { resolvedTheme } from '../lib/theme';
import { keyboardOpen } from '../lib/viewport';
import { haptic, isIOS, tildify } from '../lib/util';
import { TopBar } from '../ui/chrome';
import { PaneButtons } from '../ui/drawer';
import { GlassButton, GlassSurface } from '../ui/glass';
import { Icon } from '../ui/icons';
import { openMenu, toast } from '../ui/overlay';

const DARK: ITheme = {
  background: '#0a0b0d',
  foreground: '#e7e9ee',
  cursor: '#3be0a8',
  cursorAccent: '#0a0b0d',
  selectionBackground: 'rgba(59,224,168,0.3)',
  black: '#2a2d33',
  red: '#ff6b6b',
  green: '#5fe3a1',
  yellow: '#ffd166',
  blue: '#6aa9ff',
  magenta: '#d58cff',
  cyan: '#4fd6e0',
  white: '#d5d8de',
  brightBlack: '#5c616b',
  brightRed: '#ff8787',
  brightGreen: '#84f0b8',
  brightYellow: '#ffe08a',
  brightBlue: '#93c2ff',
  brightMagenta: '#e5adff',
  brightCyan: '#7de8ef',
  brightWhite: '#ffffff',
};

const LIGHT: ITheme = {
  background: '#fbfbfc',
  foreground: '#1d1f24',
  cursor: '#00a676',
  cursorAccent: '#fbfbfc',
  selectionBackground: 'rgba(0,166,118,0.22)',
  black: '#1d1f24',
  red: '#c8302b',
  green: '#13854e',
  yellow: '#946200',
  blue: '#1f5fd1',
  magenta: '#9a3fc7',
  cyan: '#0b7f8a',
  white: '#6b7079',
  brightBlack: '#8a8f98',
  brightRed: '#e0443e',
  brightGreen: '#1a9c5d',
  brightYellow: '#a87200',
  brightBlue: '#2f74ea',
  brightMagenta: '#b356df',
  brightCyan: '#12929e',
  brightWhite: '#1d1f24',
};

type Mod = 'off' | 'once' | 'lock';

function ctrlChar(ch: string): string | null {
  if (ch.length !== 1) return null;
  const c = ch.toLowerCase();
  if (c >= 'a' && c <= 'z') return String.fromCharCode(c.charCodeAt(0) - 96);
  const map: Record<string, number> = {
    '@': 0,
    ' ': 0,
    '[': 27,
    '\\': 28,
    ']': 29,
    '^': 30,
    _: 31,
    '?': 127,
    '2': 0,
    '3': 27,
    '4': 28,
    '5': 29,
    '6': 30,
    '7': 31,
    '8': 127,
  };
  const v = map[ch];
  return v === undefined ? null : String.fromCharCode(v);
}

function fontBy(d: number): void {
  updateSettings({ termFontSize: Math.max(9, Math.min(22, settings.peek().termFontSize + d)) });
}

const keep = (e: PointerEvent): void => e.preventDefault(); // keep the keyboard up

function Key({
  label,
  data,
  wide,
  testid,
  aria,
  onKey,
}: {
  label: string;
  data: string;
  wide?: boolean;
  testid?: string;
  aria?: string;
  onKey: (data: string) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      class={`key ${wide ? 'wide' : ''}`}
      onPointerDown={keep}
      onClick={() => onKey(data)}
      data-testid={testid}
      aria-label={aria ?? label}
    >
      {label}
    </button>
  );
}

export default function TerminalScreen({
  sessionId,
  top,
}: {
  sessionId: string;
  top: boolean;
}): JSX.Element | null {
  const s = sessionById(sessionId);
  const boxRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const ctrl = useSignal<Mod>('off');
  const alt = useSignal<Mod>('off');
  const exited = useSignal<number | null | undefined>(undefined);
  const ready = useSignal(false);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const term = new Terminal({
      fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, 'JetBrains Mono', Menlo, monospace",
      fontSize: settings.peek().termFontSize,
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: false,
      macOptionIsMeta: true,
      theme: resolvedTheme.peek() === 'light' ? LIGHT : DARK,
      convertEol: false,
      smoothScrollDuration: 0,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener')));
    term.open(el);
    // WebGL is fastest on desktop; iOS Safari loses WebGL contexts under memory
    // pressure, so it uses the DOM renderer, which is reliable there.
    if (!isIOS()) {
      const loadGl = async (): Promise<void> => {
        const { WebglAddon } = await import('@xterm/addon-webgl');
        if (termRef.current !== term) return;
        const gl = new WebglAddon();
        gl.onContextLoss(() => gl.dispose());
        term.loadAddon(gl);
      };
      loadGl().catch(() => undefined);
    }

    let cols = 0;
    let rows = 0;
    const doFit = (): void => {
      if (!el.offsetWidth || !el.offsetHeight) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (term.cols !== cols || term.rows !== rows) {
        cols = term.cols;
        rows = term.rows;
        client.send({ t: 'term.resize', sessionId, cols, rows });
      }
    };
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(doFit);
    });
    ro.observe(el);

    const offTerm = client.onTerm(sessionId, {
      snapshot: (data) => {
        term.reset();
        term.write(data);
        ready.value = true;
        doFit();
      },
      data: (data) => term.write(data),
      exit: (code) => {
        exited.value = code;
        term.write(`\r\n\x1b[2m[process exited${code !== null ? ` with code ${code}` : ''}]\x1b[0m\r\n`);
      },
    });
    const unsub = client.subscribe(sessionId);

    const onData = term.onData((d) => {
      let out = d;
      if (ctrl.peek() !== 'off') {
        const c = ctrlChar(d);
        if (c !== null) out = c;
        if (ctrl.peek() === 'once') ctrl.value = 'off';
      }
      if (alt.peek() !== 'off') {
        out = `\x1b${out}`;
        if (alt.peek() === 'once') alt.value = 'off';
      }
      client.send({ t: 'term.input', sessionId, data: out });
    });

    return () => {
      onData.dispose();
      offTerm();
      unsub();
      ro.disconnect();
      cancelAnimationFrame(frame);
      termRef.current = null;
      term.dispose();
    };
  }, [sessionId, ctrl, alt, exited, ready]);

  // Live settings: font size and theme.
  useSignalEffect(() => {
    const size = settings.value.termFontSize;
    const theme = resolvedTheme.value;
    const t = termRef.current;
    if (!t) return;
    t.options.fontSize = size;
    t.options.theme = theme === 'light' ? LIGHT : DARK;
  });

  useEffect(() => {
    if (top) termRef.current?.focus();
  }, [top]);

  if (!s) return null;

  const sendKey = (data: string): void => {
    haptic('light');
    client.send({ t: 'term.input', sessionId, data });
    termRef.current?.focus();
  };
  const arrow = (dir: 'A' | 'B' | 'C' | 'D'): void => {
    const app = termRef.current?.modes.applicationCursorKeysMode;
    let seq = `${app ? '\x1bO' : '\x1b['}${dir}`;
    if (alt.peek() !== 'off') seq = `\x1b${seq}`;
    sendKey(seq);
  };
  const toggleMod = (m: typeof ctrl): void => {
    haptic('light');
    m.value = m.peek() === 'off' ? 'once' : m.peek() === 'once' ? 'lock' : 'off';
    termRef.current?.focus();
  };
  const paste = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) termRef.current?.paste(text);
    } catch {
      toast('Paste is not allowed here. Long-press the terminal instead.', 'info');
    }
  };
  const menu = (e: TargetedMouseEvent<HTMLButtonElement>): void =>
    openMenu(e.currentTarget, [
      {
        items: [
          { label: 'Rename', icon: 'pencil', onSelect: () => void renameSession(s) },
          { label: 'Clear screen', icon: 'refresh', onSelect: () => termRef.current?.clear() },
          { label: 'Archive', icon: 'archive', onSelect: () => void archiveSession(s), testid: 'menu-archive' },
        ],
      },
      {
        items: [
          {
            label: 'Close terminal',
            icon: 'trash',
            destructive: true,
            onSelect: () => void deleteSession(s),
          },
        ],
      },
    ]);

  return (
    <div class="screen term-screen" data-testid="screen-terminal" data-session-id={sessionId}>
      <div class="term-wrap">
        <div class="term-box" ref={boxRef} data-testid="terminal" />
      </div>
      <TopBar
        fade
        left={PaneButtons().left}
        titleSlot={
          <GlassButton class="title-capsule" onClick={menu} testid="term-title">
            <span class="title-main">{s.title}</span>
            <span class="title-sub">
              {exited.value !== undefined || s.status === 'exited' ? 'Exited · ' : ''}
              {tildify(s.cwd, host.value?.home)}
            </span>
          </GlassButton>
        }
        right={
          <GlassSurface class="glass-group">
            <button
              type="button"
              aria-label="Smaller text"
              onClick={() => fontBy(-1)}
              data-testid="term-font-smaller"
            >
              <Icon name="minus" size={17} stroke={2.4} />
            </button>
            <button
              type="button"
              aria-label="Larger text"
              onClick={() => fontBy(1)}
              data-testid="term-font-larger"
            >
              <Icon name="plus" size={17} stroke={2.4} />
            </button>
          </GlassSurface>
        }
      />
      <GlassSurface class="keybar" data-testid="term-keybar">
        <div class="keys-fixed">
          <Key label="esc" data={'\x1b'} testid="key-esc" aria="Escape" onKey={sendKey} />
          <Key label="tab" data={'\t'} testid="key-tab" aria="Tab" onKey={sendKey} />
          <button
            type="button"
            class={`key mod ${ctrl.value}`}
            aria-pressed={ctrl.value !== 'off'}
            aria-label="Control"
            onPointerDown={keep}
            onClick={() => toggleMod(ctrl)}
            data-testid="key-ctrl"
          >
            ctrl
          </button>
          <button
            type="button"
            class={`key mod ${alt.value}`}
            aria-pressed={alt.value !== 'off'}
            aria-label="Alt"
            onPointerDown={keep}
            onClick={() => toggleMod(alt)}
            data-testid="key-alt"
          >
            alt
          </button>
        </div>
        <div class="keys-scroll">
          <div class="arrows">
            <button
              type="button"
              class="key icon-key"
              aria-label="Left"
              onPointerDown={keep}
              onClick={() => arrow('D')}
              data-testid="key-left"
            >
              <Icon name="back" size={16} stroke={2.6} />
            </button>
            <button
              type="button"
              class="key icon-key"
              aria-label="Up"
              onPointerDown={keep}
              onClick={() => arrow('A')}
              data-testid="key-up"
            >
              <Icon name="up" size={16} stroke={2.6} />
            </button>
            <button
              type="button"
              class="key icon-key"
              aria-label="Down"
              onPointerDown={keep}
              onClick={() => arrow('B')}
              data-testid="key-down"
            >
              <Icon name="down" size={16} stroke={2.6} />
            </button>
            <button
              type="button"
              class="key icon-key"
              aria-label="Right"
              onPointerDown={keep}
              onClick={() => arrow('C')}
              data-testid="key-right"
            >
              <Icon name="forward" size={16} stroke={2.6} />
            </button>
          </div>
          <Key label="|" data="|" aria="Pipe" onKey={sendKey} />
          <Key label="/" data="/" aria="Slash" onKey={sendKey} />
          <Key label="~" data="~" aria="Tilde" onKey={sendKey} />
          <Key label="-" data="-" aria="Dash" onKey={sendKey} />
          <button
            type="button"
            class="key icon-key"
            aria-label="Paste"
            onPointerDown={keep}
            onClick={() => void paste()}
            data-testid="key-paste"
          >
            <Icon name="clipboard" size={16} stroke={2.2} />
          </button>
          <span class="key-sep" />
          <Key label="^C" data={'\x03'} testid="key-ctrl-c" aria="Control C" onKey={sendKey} />
          <Key label="^D" data={'\x04'} aria="Control D" onKey={sendKey} />
          <Key label="^Z" data={'\x1a'} aria="Control Z" onKey={sendKey} />
          <Key label="^L" data={'\x0c'} aria="Control L" onKey={sendKey} />
          <Key label="^R" data={'\x12'} aria="Control R" onKey={sendKey} />
          <Key label="home" data={'\x1b[H'} wide aria="Home" onKey={sendKey} />
          <Key label="end" data={'\x1b[F'} wide aria="End" onKey={sendKey} />
          <Key label="pgup" data={'\x1b[5~'} wide aria="Page up" onKey={sendKey} />
          <Key label="pgdn" data={'\x1b[6~'} wide aria="Page down" onKey={sendKey} />
          {[
            '_',
            '=',
            '*',
            '&',
            '$',
            '>',
            '<',
            '`',
            "'",
            '"',
            '{',
            '}',
            '[',
            ']',
            '(',
            ')',
            '#',
            '!',
            '\\',
            ':',
            ';',
          ].map((c) => (
            <Key key={c} label={c} data={c} onKey={sendKey} />
          ))}
        </div>
        <button
          type="button"
          class="key icon-key kb-toggle"
          aria-label={keyboardOpen.value ? 'Hide keyboard' : 'Show keyboard'}
          onPointerDown={keep}
          onClick={() => {
            const active = document.activeElement;
            if (keyboardOpen.value && active instanceof HTMLElement) active.blur();
            else termRef.current?.focus();
          }}
          data-testid="key-keyboard"
        >
          <Icon name={keyboardOpen.value ? 'keyboardDown' : 'keyboard'} size={18} stroke={2} />
        </button>
      </GlassSurface>
      {!ready.value && <div class="term-loading" />}
    </div>
  );
}
