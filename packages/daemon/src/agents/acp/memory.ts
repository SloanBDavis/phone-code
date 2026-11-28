/**
 * What ACP agents told us in earlier sessions: their models and permission
 * modes. An ACP agent only says these once a session exists, so a new chat
 * would have nothing to pick from; the last answer is kept (in
 * `<state>/acp-options.json`) and offered until the next session corrects it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelOption, PermissionMode } from '@phone-code/protocol';
import { stateDir } from '../../config.ts';
import { isRecord } from '../../util/guards.ts';
import { writeFileAtomic } from '../../util/files.ts';

export interface AcpOptions {
  modelOptions?: ModelOption[];
  permissionModes?: PermissionMode[];
}

let cache: Map<string, AcpOptions> | undefined;

const file = (): string => join(stateDir(), 'acp-options.json');

function load(): Map<string, AcpOptions> {
  if (cache !== undefined) return cache;
  cache = new Map();
  try {
    const parsed: unknown = JSON.parse(readFileSync(file(), 'utf8'));
    if (isRecord(parsed)) {
      for (const [id, value] of Object.entries(parsed)) {
        if (!isRecord(value)) continue;
        const models = Array.isArray(value['modelOptions'])
          ? value['modelOptions'].filter((m): m is ModelOption => isRecord(m) && typeof m['id'] === 'string')
          : undefined;
        const modes = Array.isArray(value['permissionModes'])
          ? value['permissionModes'].filter((m): m is PermissionMode => typeof m === 'string')
          : undefined;
        cache.set(id, {
          ...(models && models.length > 0 ? { modelOptions: models } : {}),
          ...(modes && modes.length > 0 ? { permissionModes: modes } : {}),
        });
      }
    }
  } catch {
    // No file yet, or unreadable: nothing remembered.
  }
  return cache;
}

/** What agent `id` offered the last time it ran a session. */
export function rememberedOptions(id: string): AcpOptions | undefined {
  return load().get(id);
}

/** Keeps what a session of agent `id` reported, when it differs from what is kept. */
export function rememberOptions(id: string, options: AcpOptions): void {
  const all = load();
  const before = all.get(id);
  const next: AcpOptions = { ...before, ...options };
  // A session knows the thinking levels of the model it runs only: the ones learnt
  // for the agent's other models stay.
  if (options.modelOptions !== undefined && before?.modelOptions !== undefined) {
    const kept = new Map(before.modelOptions.map((m) => [m.id, m.efforts]));
    next.modelOptions = options.modelOptions.map((m) => {
      const efforts = m.efforts ?? kept.get(m.id);
      return efforts === undefined ? m : Object.assign({}, m, { efforts });
    });
  }
  if (JSON.stringify(all.get(id)) === JSON.stringify(next)) return;
  all.set(id, next);
  void writeFileAtomic(file(), JSON.stringify(Object.fromEntries(all))).catch(() => undefined);
}
