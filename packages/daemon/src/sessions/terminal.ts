import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ServerMessage, SessionInfo } from '@phone-code/protocol';
import { log } from '../log.ts';
import { UserError } from '../util/errors.ts';
import { readJson, writeFileAtomic } from '../util/files.ts';
import { isRecord } from '../util/guards.ts';
import { EventLog } from './event-log.ts';
import { Fanout } from './fanout.ts';
import { ScreenWorker, type ScreenHandle } from './screen.ts';
import type { LiveSession, PersistedSession, SessionHost, Subscriber } from './types.ts';

/** Flush immediately once this much output is pending, else once per event-loop tick. */
const FLUSH_CHARS = 256 * 1024;
const PREVIEW_MS = 400;
const KILL_GRACE_MS = 2000;
const RESTORE_SEQ_MARGIN = 100_000;

export interface TerminalDeps {
  host: SessionHost;
  terminalsDir: string;
}

export interface TerminalSpawn {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

interface SavedScreen {
  cols: number;
  rows: number;
  data: string;
}

export class TerminalSession implements LiveSession {
  readonly info: SessionInfo;
  private readonly fanout: Fanout;
  private readonly log: EventLog;
  private seq: number;
  private cols: number;
  private rows: number;
  private titleLocked: boolean;
  private proc: Bun.Subprocess | undefined;
  private screen: ScreenHandle | undefined;
  private readonly decoder = new TextDecoder();
  private pending = '';
  private flushQueued = false;
  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  private exitCode: number | null = null;
  private exited = false;
  /** Screen of a terminal that ended in a previous daemon run. */
  private saved: Promise<SavedScreen | undefined> | undefined;
  private readonly command: string | undefined;

  private constructor(
    private readonly deps: TerminalDeps,
    info: SessionInfo,
    cols: number,
    rows: number,
    titleLocked: boolean,
    command: string | undefined,
    seq = 0,
  ) {
    this.info = info;
    this.seq = seq;
    this.log = new EventLog(seq, 20_000, 2_000_000);
    this.cols = cols;
    this.rows = rows;
    this.titleLocked = titleLocked;
    this.command = command;
    this.fanout = new Fanout(info.id);
  }

  private get screenPath(): string {
    return join(this.deps.terminalsDir, `${this.info.id}.json`);
  }

  static create(
    id: string,
    spawn: TerminalSpawn,
    title: string | undefined,
    command: string | undefined,
    deps: TerminalDeps,
  ): TerminalSession {
    const now = Date.now();
    const shellName = basename(spawn.argv[0] ?? 'shell');
    const defaultTitle =
      command === undefined ? `${shellName} · ${basename(spawn.cwd) || spawn.cwd}` : command.slice(0, 80);
    const info: SessionInfo = {
      id,
      kind: 'terminal',
      title: title ?? defaultTitle,
      cwd: spawn.cwd,
      createdAt: now,
      updatedAt: now,
      status: 'idle',
    };
    const s = new TerminalSession(deps, info, spawn.cols, spawn.rows, title !== undefined, command);
    try {
      s.proc = Bun.spawn(spawn.argv, {
        cwd: spawn.cwd,
        env: spawn.env,
        terminal: {
          cols: spawn.cols,
          rows: spawn.rows,
          name: 'xterm-256color',
          data: (_t, bytes) => s.onData(bytes),
        },
      });
    } catch (err) {
      log.warn(`could not spawn ${shellName}`, err);
      throw new UserError(`Could not start ${shellName}`);
    }
    s.screen = ScreenWorker.shared().open(id, spawn.cols, spawn.rows, (t) => s.onTitle(t));
    void s.proc.exited.then((code) => s.onExit(code));
    return s;
  }

  static restore(rec: PersistedSession, deps: TerminalDeps): TerminalSession {
    const info: SessionInfo = { ...rec.info, status: rec.info.status === 'error' ? 'error' : 'exited' };
    // Past any seq a client may still hold, so its `afterSeq` falls back to the saved snapshot.
    const seq = rec.seq + RESTORE_SEQ_MARGIN;
    const s = new TerminalSession(
      deps,
      info,
      rec.cols ?? 80,
      rec.rows ?? 24,
      rec.titleLocked,
      rec.command,
      seq,
    );
    s.exited = true;
    return s;
  }

  // ------------------------------------------------------------- output

  private onData(bytes: Uint8Array): void {
    this.pending += this.decoder.decode(bytes, { stream: true });
    if (this.pending.length >= FLUSH_CHARS) {
      this.flushOutput();
    } else if (!this.flushQueued) {
      this.flushQueued = true;
      setImmediate(() => this.flushOutput());
    }
  }

  private flushOutput(): void {
    this.flushQueued = false;
    if (this.pending === '') return;
    const data = this.pending;
    this.pending = '';
    this.seq += 1;
    const msg: ServerMessage = { t: 'term.data', sessionId: this.info.id, seq: this.seq, data };
    const frame = JSON.stringify(msg);
    this.log.push(this.seq, frame);
    this.fanout.publish(frame);
    this.screen?.write(data);
    this.activity();
  }

  private activity(): void {
    this.info.updatedAt = Date.now();
    // An archived terminal keeps running but does not light up as unread.
    if (this.fanout.size === 0 && this.info.unread !== true && this.info.archived !== true) {
      this.info.unread = true;
      this.deps.host.changed('structure');
    } else {
      this.deps.host.changed('activity');
    }
    this.previewTimer ??= setTimeout(() => {
      this.previewTimer = undefined;
      void this.updatePreview();
    }, PREVIEW_MS);
  }

  private async updatePreview(): Promise<void> {
    const text = await this.screen?.preview();
    if (text === undefined || text === '' || text === this.info.preview) return;
    this.info.preview = text.slice(0, 140);
    this.deps.host.changed('activity');
  }

  private onTitle(title: string): void {
    if (this.titleLocked || title.trim() === '') return;
    this.info.title = title.trim().slice(0, 100);
    this.deps.host.changed('structure');
  }

  private onExit(code: number | null): void {
    // Let the final output chunks land before reporting the exit.
    setTimeout(() => {
      this.pending += this.decoder.decode();
      this.flushOutput();
      this.exited = true;
      this.exitCode = this.proc?.signalCode === null ? code : null;
      this.info.status = 'exited';
      this.info.updatedAt = Date.now();
      this.deps.host.changed('structure');
      const msg: ServerMessage = { t: 'term.exit', sessionId: this.info.id, exitCode: this.exitCode };
      this.fanout.publish(JSON.stringify(msg));
      this.proc?.terminal?.close();
      void this.saveScreen();
    }, 20);
  }

  // ------------------------------------------------------------ snapshot

  private async saveScreen(): Promise<void> {
    const screen = this.screen;
    if (screen === undefined) return;
    const saved: SavedScreen = { cols: this.cols, rows: this.rows, data: await screen.snapshot() };
    this.saved = Promise.resolve(saved);
    await writeFileAtomic(this.screenPath, JSON.stringify(saved)).catch((err: unknown) =>
      log.warn(`could not save terminal screen ${this.info.id}`, err),
    );
  }

  private loadSaved(): Promise<SavedScreen | undefined> {
    this.saved ??= readJson(this.screenPath).then((v) =>
      isRecord(v) &&
      typeof v['data'] === 'string' &&
      typeof v['cols'] === 'number' &&
      typeof v['rows'] === 'number'
        ? { cols: v['cols'], rows: v['rows'], data: v['data'] }
        : undefined,
    );
    return this.saved;
  }

  async subscribe(sub: Subscriber, afterSeq?: number): Promise<void> {
    this.flushOutput();
    const missed = afterSeq === undefined ? undefined : this.log.since(afterSeq, this.seq);
    if (missed !== undefined) {
      for (const frame of missed) if (!this.fanout.sendTo(sub, frame)) return;
      this.attach(sub);
      return;
    }
    // The worker answers after parsing everything written before the request,
    // so the snapshot corresponds to exactly `at`; replay whatever came since.
    const at = this.seq;
    const screen = this.screen;
    const saved = screen === undefined ? await this.loadSaved() : undefined;
    const data = saved?.data ?? (await screen?.snapshot()) ?? '';
    const snapshot: ServerMessage = {
      t: 'term.snapshot',
      sessionId: this.info.id,
      seq: at,
      cols: saved?.cols ?? this.cols,
      rows: saved?.rows ?? this.rows,
      data,
    };
    if (!this.fanout.sendTo(sub, JSON.stringify(snapshot))) return;
    const after = this.log.since(at, this.seq) ?? [];
    for (const frame of after) if (!this.fanout.sendTo(sub, frame)) return;
    this.attach(sub);
  }

  private attach(sub: Subscriber): void {
    this.fanout.add(sub);
    if (this.exited) {
      const msg: ServerMessage = { t: 'term.exit', sessionId: this.info.id, exitCode: this.exitCode };
      this.fanout.sendTo(sub, JSON.stringify(msg));
    }
    if (this.info.unread === true) {
      this.info.unread = false;
      this.deps.host.changed('structure');
    }
  }

  unsubscribe(sub: Subscriber): void {
    this.fanout.delete(sub);
  }

  hasSubscribers(): boolean {
    return this.fanout.size > 0;
  }

  // -------------------------------------------------------------- input

  input(data: string): void {
    if (!this.exited) this.proc?.terminal?.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited || (cols === this.cols && rows === this.rows)) return;
    this.cols = cols;
    this.rows = rows;
    this.flushOutput();
    this.proc?.terminal?.resize(cols, rows);
    this.screen?.resize(cols, rows);
  }

  rename(title: string): void {
    this.info.title = title;
    this.titleLocked = true;
    this.deps.host.changed('structure');
  }

  /** Archiving a terminal only hides it: the shell keeps running until it exits. */
  setArchived(archived: boolean): Promise<void> {
    if (archived) {
      this.info.archived = true;
      this.info.unread = false;
    } else delete this.info.archived;
    this.deps.host.changed('structure');
    return Promise.resolve();
  }

  toRecord(): PersistedSession {
    return {
      info: this.info,
      seq: this.seq,
      titleLocked: this.titleLocked,
      cols: this.cols,
      rows: this.rows,
      ...(this.command === undefined ? {} : { command: this.command }),
    };
  }

  async persist(): Promise<void> {
    if (!this.exited) await this.saveScreen();
  }

  async dispose(): Promise<void> {
    this.fanout.clear();
    if (this.previewTimer !== undefined) clearTimeout(this.previewTimer);
    const proc = this.proc;
    if (proc !== undefined && proc.exitCode === null && proc.signalCode === null) {
      // Closing the PTY hangs up the whole session (foreground jobs included).
      proc.terminal?.close();
      proc.kill('SIGHUP');
      const timer = setTimeout(() => proc.kill('SIGKILL'), KILL_GRACE_MS);
      await proc.exited;
      clearTimeout(timer);
    }
    this.screen?.close();
    this.screen = undefined;
  }

  async removeFiles(): Promise<void> {
    await rm(this.screenPath, { force: true });
  }
}
