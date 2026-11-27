import { signal } from '@preact/signals';
import { isRecord } from './guards';
import { load, save } from './storage';

/**
 * Where the main area's panes sit when there are several (tiles), as
 * fractions of the area. Two are side by side; three are side by side in a
 * wide window, else one tall and two stacked; four are a 2 by 2 grid. The
 * lines between them can be dragged: where they were left is kept.
 */
export interface Tile {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A line between tiles that can be dragged. */
export interface Divider {
  /** Which split it moves. */
  key: keyof Splits;
  /** `v`: a vertical line (moves left and right). `h`: a horizontal one. */
  dir: 'v' | 'h';
  /** Where it is, 0..1 across (v) or down (h). */
  at: number;
  /** The stretch it covers along its length, 0..1. */
  from: number;
  to: number;
}

export interface Splits {
  /** The column line of two columns. */
  col: number;
  /** The row line of two rows. */
  row: number;
  /** The two column lines of three in a row. */
  a: number;
  b: number;
}

const DEFAULTS: Splits = { col: 0.5, row: 0.5, a: 1 / 3, b: 2 / 3 };
const KEY = 'pc.tileSplits';
/** No tile is dragged narrower or shorter than this. */
const MIN_W = 300;
const MIN_H = 220;
/** Below this width three tiles are one tall and two stacked. */
export const THREE_IN_A_ROW = 1260;

const frac = (v: unknown, d: number): number => (typeof v === 'number' && v > 0.05 && v < 0.95 ? v : d);

function restore(): Splits {
  const v = load<Record<string, unknown> | null>(KEY, null, (x): x is Record<string, unknown> => isRecord(x));
  if (v === null) return DEFAULTS;
  const s = {
    col: frac(v['col'], DEFAULTS.col),
    row: frac(v['row'], DEFAULTS.row),
    a: frac(v['a'], DEFAULTS.a),
    b: frac(v['b'], DEFAULTS.b),
  };
  return s.a < s.b ? s : { ...s, a: DEFAULTS.a, b: DEFAULTS.b };
}

export const splits = signal<Splits>(restore());

export function tiles(count: number, width: number, s: Splits = splits.value): Tile[] {
  if (count <= 1) return [{ x: 0, y: 0, w: 1, h: 1 }];
  if (count === 2)
    return [
      { x: 0, y: 0, w: s.col, h: 1 },
      { x: s.col, y: 0, w: 1 - s.col, h: 1 },
    ];
  if (count === 3 && width >= THREE_IN_A_ROW)
    return [
      { x: 0, y: 0, w: s.a, h: 1 },
      { x: s.a, y: 0, w: s.b - s.a, h: 1 },
      { x: s.b, y: 0, w: 1 - s.b, h: 1 },
    ];
  if (count === 3)
    return [
      { x: 0, y: 0, w: s.col, h: 1 },
      { x: s.col, y: 0, w: 1 - s.col, h: s.row },
      { x: s.col, y: s.row, w: 1 - s.col, h: 1 - s.row },
    ];
  return [
    { x: 0, y: 0, w: s.col, h: s.row },
    { x: s.col, y: 0, w: 1 - s.col, h: s.row },
    { x: 0, y: s.row, w: s.col, h: 1 - s.row },
    { x: s.col, y: s.row, w: 1 - s.col, h: 1 - s.row },
  ];
}

export function dividers(count: number, width: number, s: Splits = splits.value): Divider[] {
  if (count <= 1) return [];
  if (count === 2) return [{ key: 'col', dir: 'v', at: s.col, from: 0, to: 1 }];
  if (count === 3 && width >= THREE_IN_A_ROW)
    return [
      { key: 'a', dir: 'v', at: s.a, from: 0, to: 1 },
      { key: 'b', dir: 'v', at: s.b, from: 0, to: 1 },
    ];
  return [
    { key: 'col', dir: 'v', at: s.col, from: 0, to: 1 },
    { key: 'row', dir: 'h', at: s.row, from: count === 3 ? s.col : 0, to: 1 },
  ];
}

/** Moves a line to `at` (0..1 of the area, `size` points long that way), within what the tiles need. */
export function moveSplit(key: keyof Splits, at: number, size: number): void {
  const s = splits.peek();
  const min = Math.min(0.45, (key === 'row' ? MIN_H : MIN_W) / Math.max(1, size));
  const lo = key === 'b' ? s.a + min : min;
  const hi = key === 'a' ? s.b - min : 1 - min;
  if (hi < lo) return;
  splits.value = { ...s, [key]: Math.min(hi, Math.max(lo, at)) };
}

export function saveSplits(): void {
  save(KEY, splits.peek());
}

/** Back to even tiles (a double-click on a line). */
export function resetSplit(key: keyof Splits): void {
  const s = splits.peek();
  splits.value =
    key === 'a' || key === 'b' ? { ...s, a: DEFAULTS.a, b: DEFAULTS.b } : { ...s, [key]: DEFAULTS[key] };
  saveSplits();
}
