/**
 * Line-based unified diff (Myers O(ND)), so tool cards can show real diffs
 * with +/- counts no matter what the agent reports.
 */

type Op = { kind: ' ' | '-' | '+'; line: string };

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Myers shortest edit script. Falls back to a block replace when the inputs are huge and very different. */
function diffLines(a: string[], b: string[]): Op[] {
  // Trim common prefix/suffix first: cheap and makes the typical edit tiny.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const prefix: Op[] = a.slice(0, start).map((line) => ({ kind: ' ', line }));
  const suffix: Op[] = a.slice(endA).map((line) => ({ kind: ' ', line }));
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  const n = A.length;
  const m = B.length;
  const max = n + m;
  const middle: Op[] = [];
  if (n === 0 || m === 0 || max > 20_000) {
    for (const line of A) middle.push({ kind: '-', line });
    for (const line of B) middle.push({ kind: '+', line });
    return [...prefix, ...middle, ...suffix];
  }
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  // Keep the trace under ~20 MB.
  const dLimit = Math.max(16, Math.floor(5_000_000 / (2 * max + 2)));
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))) {
        x = v[offset + k + 1] ?? 0;
      } else {
        x = (v[offset + k - 1] ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    if (d > dLimit) break; // pathological; bail to block replace below
  }
  if (!found) {
    for (const line of A) middle.push({ kind: '-', line });
    for (const line of B) middle.push({ kind: '+', line });
    return [...prefix, ...middle, ...suffix];
  }
  // Backtrack.
  let x = n;
  let y = m;
  const rev: Op[] = [];
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    if (!vd) break;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (vd[offset + k - 1] ?? 0) < (vd[offset + k + 1] ?? 0))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[offset + prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      rev.push({ kind: ' ', line: A[x - 1] ?? '' });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) rev.push({ kind: '+', line: B[y - 1] ?? '' });
      else rev.push({ kind: '-', line: A[x - 1] ?? '' });
    }
    x = prevX;
    y = prevY;
  }
  rev.reverse();
  return [...prefix, ...rev, ...suffix];
}

export interface UnifiedDiff {
  patch: string;
  added: number;
  removed: number;
}

/**
 * Unified diff of two texts. `lineOffset` shifts hunk headers when only a
 * fragment of the file is known (e.g. an Edit's old_string located at line N).
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  path: string,
  opts: { context?: number; lineOffset?: number; isNew?: boolean } = {},
): UnifiedDiff {
  const context = opts.context ?? 3;
  const offset = opts.lineOffset ?? 0;
  const ops = diffLines(splitLines(oldText), splitLines(newText));
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === '+') added++;
    else if (op.kind === '-') removed++;
  }
  const header = `--- ${opts.isNew ? '/dev/null' : `a/${path}`}\n+++ b/${path}\n`;
  if (added === 0 && removed === 0) return { patch: header, added, removed };

  // Group changes into hunks with `context` lines around them.
  const out: string[] = [];
  let i = 0;
  let oldLine = 1;
  let newLine = 1;
  // Precompute old/new line numbers at each op index.
  const oldAt: number[] = [];
  const newAt: number[] = [];
  for (const op of ops) {
    oldAt.push(oldLine);
    newAt.push(newLine);
    if (op.kind !== '+') oldLine++;
    if (op.kind !== '-') newLine++;
  }
  while (i < ops.length) {
    // find next change
    while (i < ops.length && ops[i]?.kind === ' ') i++;
    if (i >= ops.length) break;
    const hunkStart = Math.max(0, i - context);
    let j = i;
    let lastChange = i;
    while (j < ops.length) {
      if (ops[j]?.kind !== ' ') lastChange = j;
      else if (j - lastChange > context * 2) break;
      j++;
    }
    const hunkEnd = Math.min(ops.length, lastChange + context + 1);
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (let h = hunkStart; h < hunkEnd; h++) {
      const op = ops[h];
      if (!op) continue;
      if (op.kind !== '+') oldCount++;
      if (op.kind !== '-') newCount++;
      body.push(`${op.kind}${op.line}`);
    }
    const oStart = (oldAt[hunkStart] ?? 1) + offset;
    const nStart = (newAt[hunkStart] ?? 1) + offset;
    out.push(
      `@@ -${oldCount === 0 ? oStart - 1 : oStart},${oldCount} +${newCount === 0 ? nStart - 1 : nStart},${newCount} @@`,
    );
    out.push(...body);
    i = hunkEnd;
  }
  return { patch: header + out.join('\n') + '\n', added, removed };
}

/** Count +/- lines of an existing unified diff (headers excluded). */
export function countPatch(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

/** 0-based line index where `needle` starts in `haystack`, or -1. */
export function lineIndexOf(haystack: string, needle: string): number {
  if (!needle) return -1;
  const at = haystack.indexOf(needle);
  if (at < 0) return -1;
  let lines = 0;
  for (let i = 0; i < at; i++) if (haystack.charCodeAt(i) === 10) lines++;
  return lines;
}
