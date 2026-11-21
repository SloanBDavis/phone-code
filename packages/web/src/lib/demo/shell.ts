/** A tiny fake zsh for the demo terminal: line editing, history and a few colorful commands. */

const E = '\x1b[';
const c = (code: string, s: string): string => `${E}${code}m${s}${E}0m`;
const green = (s: string): string => c('38;5;114', s);
const blue = (s: string): string => c('38;5;75', s);
const pink = (s: string): string => c('38;5;213', s);
const dim = (s: string): string => c('2', s);
const bold = (s: string): string => c('1', s);
const yellow = (s: string): string => c('38;5;221', s);
const red = (s: string): string => c('38;5;203', s);
const cyan = (s: string): string => c('38;5;80', s);

export class DemoShell {
  private line = '';
  private hist: string[] = [];
  private hIdx = 0;
  private cwd: string;
  /** Everything written so far, to rebuild the screen as a snapshot. */
  private screen = '';
  private timers: number[] = [];

  constructor(
    cwd: string,
    private readonly out: (data: string) => void,
    exited = false,
  ) {
    this.cwd = cwd;
    if (exited) {
      this.emit(
        `${dim('$')} npm run dev\r\n\r\n  ${green('VITE v6.0.3')}  ready in ${bold('312')} ms\r\n\r\n  ${green('➜')}  ${bold('Local')}:   ${cyan('http://localhost:5173/')}\r\n  ${green('➜')}  ${dim('Network: use --host to expose')}\r\n\r\n${dim('^C')}\r\n${dim('[process exited with code 0]')}\r\n`,
        false,
      );
      return;
    }
    this.emit(
      `${dim('Last login: Fri Nov 20 09:12:44 on ttys004')}\r\n${dim('Type')} ${bold('help')} ${dim('to see what this demo shell can do.')}\r\n\r\n`,
      false,
    );
    this.prompt(false);
  }

  snapshot(): string {
    return this.screen;
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
  }

  private emit(s: string, live = true): void {
    this.screen += s;
    if (this.screen.length > 200_000) this.screen = this.screen.slice(-150_000);
    if (live) this.out(s);
  }

  private short(): string {
    return this.cwd.replace(/^\/Users\/maya/, '~');
  }

  private prompt(live = true): void {
    this.emit(`${green('maya')}${dim('@')}studio ${blue(this.short())} ${pink('❯')} `, live);
  }

  input(data: string): void {
    // Arrow keys (normal and application cursor mode).
    if (data === `${E}A` || data === '\x1bOA') return this.recall(-1);
    if (data === `${E}B` || data === '\x1bOB') return this.recall(1);
    if (data.startsWith('\x1b')) return;
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') this.run();
      else if (ch === '\x7f' || ch === '\b') {
        if (this.line) {
          this.line = this.line.slice(0, -1);
          this.emit('\b \b');
        }
      } else if (ch === '\x03') {
        this.emit('^C\r\n');
        this.line = '';
        this.prompt();
      } else if (ch === '\x0c') {
        this.emit(`${E}2J${E}H`);
        this.prompt();
        this.emit(this.line);
      } else if (ch === '\t') {
        this.complete();
      } else if (ch >= ' ') {
        this.line += ch;
        this.emit(ch);
      }
    }
  }

  private recall(dir: number): void {
    if (!this.hist.length) return;
    this.hIdx = Math.max(0, Math.min(this.hist.length, this.hIdx + dir));
    const next = this.hist[this.hIdx] ?? '';
    this.emit('\b \b'.repeat(this.line.length) + next);
    this.line = next;
  }

  private complete(): void {
    const words = ['git status', 'git log', 'ls', 'npm test', 'help', 'colors', 'phonecode', 'clear'];
    const hit = words.find((w) => w.startsWith(this.line) && w !== this.line);
    if (!hit) return;
    this.emit(hit.slice(this.line.length));
    this.line = hit;
  }

  private run(): void {
    const cmd = this.line.trim();
    this.line = '';
    this.emit('\r\n');
    if (cmd) {
      this.hist.push(cmd);
      this.hIdx = this.hist.length;
    }
    const [name = '', ...args] = cmd.split(/\s+/);
    const later = (ms: number, fn: () => void): void => {
      this.timers.push(window.setTimeout(fn, ms));
    };
    switch (name) {
      case '':
        break;
      case 'help':
        this.emit(
          [
            bold('Demo shell commands'),
            `  ${cyan('ls')}          list files`,
            `  ${cyan('git status')}  show a dirty working tree`,
            `  ${cyan('git log')}     recent commits`,
            `  ${cyan('npm test')}    run a (fake) test suite`,
            `  ${cyan('colors')}      256-color palette`,
            `  ${cyan('phonecode')}   about this app`,
            `  ${cyan('echo')}, ${cyan('pwd')}, ${cyan('cd')}, ${cyan('date')}, ${cyan('whoami')}, ${cyan('clear')}`,
            '',
          ].join('\r\n'),
        );
        break;
      case 'ls':
        this.emit(
          `${blue(bold('e2e'))}  ${blue(bold('packages'))}  ${blue(bold('node_modules'))}  LICENSE  README.md  ${yellow('package.json')}  bun.lock\r\n`,
        );
        break;
      case 'pwd':
        this.emit(`${this.cwd}\r\n`);
        break;
      case 'cd': {
        const to = args[0] ?? '~';
        this.cwd =
          to === '~'
            ? '/Users/maya'
            : to === '..'
              ? this.cwd.slice(0, this.cwd.lastIndexOf('/')) || '/'
              : to.startsWith('/')
                ? to
                : `${this.cwd}/${to}`;
        break;
      }
      case 'whoami':
        this.emit('maya\r\n');
        break;
      case 'date':
        this.emit(`${new Date().toString()}\r\n`);
        break;
      case 'echo':
        this.emit(`${args.join(' ')}\r\n`);
        break;
      case 'clear':
        this.emit(`${E}2J${E}3J${E}H`);
        break;
      case 'git':
        if (args[0] === 'log') {
          this.emit(
            [
              `${yellow('a41c9e2')} ${dim('(')}${cyan(bold('HEAD -> main'))}${dim(')')} web: liquid glass composer`,
              `${yellow('7d0b331')} daemon: replay chat events after reconnect`,
              `${yellow('f19e7a0')} protocol: push payload`,
              `${yellow('2c88d14')} web: terminal key bar with sticky modifiers`,
              '',
            ].join('\r\n'),
          );
        } else {
          this.emit(
            [
              `On branch ${bold('main')}`,
              `Your branch is ahead of ${green("'origin/main'")} by 2 commits.`,
              '',
              'Changes not staged for commit:',
              `  ${red('modified:   packages/web/src/ui/glass.tsx')}`,
              `  ${red('modified:   packages/web/src/styles/glass.css')}`,
              '',
              'Untracked files:',
              `  ${red('packages/web/public/icons/')}`,
              '',
            ].join('\r\n'),
          );
        }
        break;
      case 'npm':
      case 'bun': {
        if (args[0] !== 'test' && args[0] !== 'run') {
          this.emit(`${dim('usage:')} ${name} test\r\n`);
          break;
        }
        const tests = [
          'protocol › round-trips every message',
          'pairing › rejects an expired code',
          'pairing › hands off to the home screen app',
          'chat › applies deltas in order',
          'chat › resumes after reconnect',
          'terminal › replays scrollback',
        ];
        this.emit(`${dim('$ vitest run')}\r\n\r\n`);
        tests.forEach((t, i) => {
          later(140 * (i + 1), () => this.emit(` ${green('✓')} ${t} ${dim(`${12 + i * 7}ms`)}\r\n`));
        });
        later(140 * (tests.length + 1) + 120, () => {
          this.emit(
            `\r\n ${bold('Test Files')}  ${green(bold('3 passed'))} ${dim('(3)')}\r\n      ${bold('Tests')}  ${green(bold(`${tests.length} passed`))} ${dim(`(${tests.length})`)}\r\n   ${bold('Duration')}  1.04s\r\n\r\n`,
          );
          this.prompt();
        });
        return;
      }
      case 'colors': {
        let s = '';
        for (let i = 0; i < 16; i++) s += `${E}48;5;${i}m   `;
        s += `${E}0m\r\n`;
        for (let row = 0; row < 6; row++) {
          for (let i = 0; i < 36; i++) s += `${E}48;5;${16 + row * 36 + i}m `;
          s += `${E}0m\r\n`;
        }
        for (let i = 232; i < 256; i++) s += `${E}48;5;${i}m  `;
        this.emit(`${s}${E}0m\r\n`);
        break;
      }
      case 'phonecode':
      case 'neofetch':
        this.emit(
          [
            `   ${green('╭──────╮')}    ${bold('maya')}@${bold('studio')}`,
            `   ${green('│')} ${pink('›_')}   ${green('│')}    ${dim('─────────────')}`,
            `   ${green('│')}      ${green('│')}    ${cyan('App')}      phone-code 0.1.0`,
            `   ${green('│')}  ${dim('──')}  ${green('│')}    ${cyan('Host')}     macOS 15.4 (arm64)`,
            `   ${green('╰──────╯')}    ${cyan('Shell')}    zsh 5.9`,
            `               ${cyan('Agents')}   Claude Code, Codex`,
            `               ${cyan('License')}  MIT, free forever`,
            '',
          ].join('\r\n'),
        );
        break;
      default:
        this.emit(`zsh: command not found: ${name}\r\n`);
    }
    this.prompt();
  }
}
