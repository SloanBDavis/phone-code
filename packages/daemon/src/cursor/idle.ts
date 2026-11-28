/**
 * How long this computer has gone without keyboard or mouse input: what tells
 * "at the desk" from "away" when a Cursor turn ends (agents/cursor-app/index.ts).
 * `undefined` where there is no way to tell (anything but macOS).
 */
import { readFile } from 'node:fs/promises';

const IOREG_TIMEOUT_MS = 2000;

/** `ioreg -c IOHIDSystem` prints `"HIDIdleTime" = <nanoseconds>`. */
export function parseHidIdle(out: string): number | undefined {
  const ns = /"HIDIdleTime"\s*=\s*(\d+)/.exec(out)?.[1];
  return ns === undefined ? undefined : Math.floor(Number(ns) / 1e6);
}

export async function computerIdleMs(): Promise<number | undefined> {
  // Test hook: a file holding the idle time in milliseconds.
  const file = process.env['PHONECODE_IDLE_FILE'];
  if (file) {
    try {
      const ms = Number((await readFile(file, 'utf8')).trim());
      return Number.isFinite(ms) ? ms : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform !== 'darwin') return undefined;
  try {
    const p = Bun.spawn(['ioreg', '-c', 'IOHIDSystem', '-d', '4'], {
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: IOREG_TIMEOUT_MS,
    });
    return parseHidIdle(await new Response(p.stdout).text());
  } catch {
    return undefined;
  }
}
