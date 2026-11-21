/**
 * Worker thread that keeps a headless xterm per terminal session, so parsing
 * terminal output (the expensive part: ~10-20 MB/s) never blocks the main
 * thread's PTY reads, websocket fan-out or keystrokes.
 */
import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal } from '@xterm/headless';
import { isScreenRequest, type ScreenEvent, type ScreenRequest } from './screen-protocol.ts';

const SCROLLBACK = 3000;

interface Screen {
  term: Terminal;
  serializer: SerializeAddon;
}

const screens = new Map<string, Screen>();

function post(ev: ScreenEvent): void {
  postMessage(ev);
}

function lastLine(term: Terminal): string {
  const buf = term.buffer.active;
  const bottom = buf.baseY + buf.cursorY;
  for (let y = bottom; y >= 0 && y > bottom - term.rows; y--) {
    const text = buf.getLine(y)?.translateToString(true).trim();
    if (text !== undefined && text !== '') return text;
  }
  return '';
}

function handle(m: ScreenRequest): void {
  if (m.op === 'open') {
    const term = new Terminal({ cols: m.cols, rows: m.rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const serializer = new SerializeAddon();
    term.loadAddon(serializer);
    term.onTitleChange((title) => post({ op: 'title', id: m.id, title }));
    screens.set(m.id, { term, serializer });
    return;
  }
  const screen = screens.get(m.id);
  switch (m.op) {
    case 'write':
      screen?.term.write(m.data, () => post({ op: 'ack', id: m.id, chars: m.data.length }));
      return;
    case 'resize':
      screen?.term.resize(m.cols, m.rows);
      return;
    case 'snapshot':
      if (screen === undefined) post({ op: 'reply', req: m.req, text: '' });
      else
        screen.term.write('', () => post({ op: 'reply', req: m.req, text: screen.serializer.serialize() }));
      return;
    case 'preview':
      if (screen === undefined) post({ op: 'reply', req: m.req, text: '' });
      else screen.term.write('', () => post({ op: 'reply', req: m.req, text: lastLine(screen.term) }));
      return;
    case 'close':
      screen?.term.dispose();
      screens.delete(m.id);
      return;
  }
}

self.addEventListener('message', (e: MessageEvent<unknown>) => {
  if (isScreenRequest(e.data)) handle(e.data);
});
