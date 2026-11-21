/**
 * Minimal stderr logger. Never pass tokens, pairing codes or message payloads
 * to it: logs end up in bug reports.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const envLevel = process.env['PHONECODE_LOG'];
const threshold =
  envLevel === 'debug' || envLevel === 'info' || envLevel === 'warn' || envLevel === 'error'
    ? order[envLevel]
    : order.info;

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return 'unknown error';
  }
}

function write(level: Level, msg: string, err?: unknown): void {
  if (order[level] < threshold) return;
  const ts = new Date().toISOString().slice(11, 23);
  const detail = err === undefined ? '' : ` ${describeError(err)}`;
  process.stderr.write(`${ts} ${level.padEnd(5)} ${msg}${detail}\n`);
}

export const log = {
  debug: (msg: string, err?: unknown): void => write('debug', msg, err),
  info: (msg: string, err?: unknown): void => write('info', msg, err),
  warn: (msg: string, err?: unknown): void => write('warn', msg, err),
  error: (msg: string, err?: unknown): void => write('error', msg, err),
};
