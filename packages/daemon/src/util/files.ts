import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { log } from '../log.ts';

/** Read and parse a JSON file; `undefined` if missing or unreadable. */
export async function readJson(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  try {
    return (await file.json()) as unknown;
  } catch (err) {
    log.warn(`could not parse ${path}`, err);
    return undefined;
  }
}

let tmpCounter = 0;

/** Atomic write (tmp + rename). State files are private to the user (0600). */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  tmpCounter += 1;
  const tmp = `${path}.${process.pid}.${tmpCounter}.tmp`;
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Serializes writes of one JSON document: `schedule()` coalesces bursts into
 * a single write after `delayMs`; `flush()` writes now and waits.
 */
export class JsonWriter {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly produce: () => unknown,
    private readonly delayMs = 300,
  ) {}

  schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.write();
    }, this.delayMs);
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.write();
  }

  private write(): Promise<void> {
    const data = JSON.stringify(this.produce());
    this.chain = this.chain
      .then(() => writeFileAtomic(this.path, data))
      .catch((err: unknown) => log.error(`failed to write ${this.path}`, err));
    return this.chain;
  }
}

/** A random id. Never starts with `-`: ids are typed as command arguments (`phonecode revoke <id>`). */
export function randomId(bytes = 9): string {
  for (;;) {
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');
    if (!id.startsWith('-')) return id;
  }
}
