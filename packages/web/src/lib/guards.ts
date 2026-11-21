/** Runtime checks for data that crosses a trust boundary (network, storage). */

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function isString(x: unknown): x is string {
  return typeof x === 'string';
}

export function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every(isString);
}

/** JSON.parse that yields `unknown` instead of `any`. */
export function parseJson(text: string): unknown {
  try {
    const v: unknown = JSON.parse(text);
    return v;
  } catch {
    return undefined;
  }
}
