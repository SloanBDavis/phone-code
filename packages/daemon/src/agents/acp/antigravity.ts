/**
 * Antigravity CLI's own conversation store, for "All chats" text search
 * (history/service.ts), the way Claude Code's and Codex's files are searched.
 *
 *   ~/.gemini/antigravity-cli/
 *     brain/<conversation id>/
 *       .system_generated/logs/transcript.jsonl   one line per step: the user's
 *                                                 requests and the model's answers
 *       implementation_plan.md, task.md, …        its artifacts (acp/config.ts)
 *     conversation_summaries.db                   SQLite: title, workspace, last change
 *
 * Seen in agy 1.5.18. Only read, never written; anything missing or in another
 * shape is skipped, so a later agy that changes it just drops out of search.
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { capText, eachJsonLine, type Conversation, type FileStat } from '../../history/index-file.ts';
import { statAll, subdirs } from '../../history/sources.ts';
import { log } from '../../log.ts';
import type { HarnessHistory } from '../types.ts';
import { isRec, oneLine, str } from '../shared/common.ts';

/** Antigravity's folder, relative to the home folder. */
const ANTIGRAVITY_HOME = '.gemini/antigravity-cli';
/** Where each conversation keeps its artifacts and logs, relative to the home folder. */
export const ANTIGRAVITY_BRAIN = `${ANTIGRAVITY_HOME}/brain`;

const TRANSCRIPT = '.system_generated/logs/transcript.jsonl';

interface Summary {
  title: string;
  cwd?: string;
  updatedAt?: number;
}

/** The request the user typed, without the context agy wraps around it. */
export function antigravityUserText(content: string): string {
  const m = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(content);
  return (m?.[1] ?? content).trim();
}

function fileUriPath(uri: string): string | undefined {
  try {
    return uri.startsWith('file://') ? decodeURIComponent(new URL(uri).pathname) : undefined;
  } catch {
    return undefined;
  }
}

/** Titles, folders and times from conversation_summaries.db, read once per index refresh. */
function readSummaries(home: string): Map<string, Summary> {
  const out = new Map<string, Summary>();
  const file = path.join(home, ANTIGRAVITY_HOME, 'conversation_summaries.db');
  if (!existsSync(file)) return out;
  let db: Database | undefined;
  try {
    db = new Database(file, { readonly: true });
    const rows: unknown[] = db
      .query('SELECT conversation_id, title, workspace_uris, last_modified_time FROM conversation_summaries')
      .all();
    for (const r of rows.filter(isRec)) {
      const id = str(r['conversation_id']);
      if (id === undefined) continue;
      let cwd: string | undefined;
      try {
        const uris: unknown = JSON.parse(str(r['workspace_uris']) ?? '[]');
        const first = Array.isArray(uris) ? uris.find((u): u is string => typeof u === 'string') : undefined;
        cwd = first === undefined ? undefined : fileUriPath(first);
      } catch {
        // no folder
      }
      const at = Date.parse(str(r['last_modified_time']) ?? '');
      out.set(id, {
        title: str(r['title']) ?? '',
        ...(cwd === undefined ? {} : { cwd }),
        ...(Number.isFinite(at) ? { updatedAt: at } : {}),
      });
    }
  } catch (e) {
    log.debug('could not read Antigravity conversation summaries', e);
  } finally {
    db?.close();
  }
  return out;
}

export function antigravityHistory(): HarnessHistory {
  // The index lists every file, then extracts the changed ones: the summaries are read
  // on each list() and shared by the extracts that follow it.
  let summaries = new Map<string, Summary>();
  return {
    async list(): Promise<FileStat[]> {
      const home = homedir();
      summaries = readSummaries(home);
      const dirs = await subdirs(path.join(home, ANTIGRAVITY_BRAIN));
      return statAll(dirs.map((d) => path.join(d, TRANSCRIPT)));
    },
    async extract(f: FileStat): Promise<Conversation | undefined> {
      const id = path.basename(path.dirname(path.dirname(path.dirname(f.path))));
      const pieces: string[] = [];
      let firstPrompt: string | undefined;
      let count = 0;
      let last = 0;
      await eachJsonLine(f.path, (e) => {
        const content = str(e.content);
        const ts = Date.parse(str(e.created_at) ?? '');
        if (Number.isFinite(ts) && ts > last) last = ts;
        if (e.type === 'USER_INPUT' && e.source === 'USER_EXPLICIT' && content !== undefined) {
          const text = antigravityUserText(content);
          if (text === '') return;
          firstPrompt ??= text;
          count++;
          pieces.push(text);
        } else if (e.type === 'PLANNER_RESPONSE' && content !== undefined && content !== '') {
          count++;
          pieces.push(content);
        }
      });
      // A session opened and never used has no request: nothing to find or reopen.
      if (firstPrompt === undefined) return undefined;
      const s = summaries.get(id);
      return {
        resumeId: id,
        cwd: s?.cwd ?? homedir(),
        title: oneLine(s?.title || firstPrompt.replace(/^\/\S+\s+/, ''), 100),
        messageCount: count,
        updatedAt: Math.max(s?.updatedAt ?? 0, last),
        text: capText(pieces),
      };
    },
  };
}
