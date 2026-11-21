/** Small runtime guards for JSON coming back from the daemon. */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function record(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new Error(`expected an object, got ${JSON.stringify(v)}`);
  return v;
}

export function str(v: unknown, key: string): string {
  const x = record(v)[key];
  if (typeof x !== 'string') throw new Error(`expected string "${key}" in ${JSON.stringify(v)}`);
  return x;
}

export function num(v: unknown, key: string): number {
  const x = record(v)[key];
  if (typeof x !== 'number') throw new Error(`expected number "${key}" in ${JSON.stringify(v)}`);
  return x;
}

export function parse(text: string): unknown {
  return JSON.parse(text);
}
