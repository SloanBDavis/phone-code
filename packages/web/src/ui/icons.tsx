import type { JSX } from 'preact';

/** Line icons drawn on a 24-unit grid, stroked with currentColor. */
const P: Record<string, string> = {
  back: 'M15 5l-7 7 7 7',
  forward: 'M9 5l7 7-7 7',
  down: 'M6 9l6 6 6-6',
  up: 'M6 15l6-6 6 6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  send: 'M12 19V5M6 11l6-6 6 6',
  ellipsis: 'M5.5 12h.01M12 12h.01M18.5 12h.01',
  gear: 'M12 15.2a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4zM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7.6 7.6 0 01-2 1.2l-.3 2h-4l-.3-2a7.6 7.6 0 01-2-1.2l-1.9.7-2-3.4 1.6-1.2a7.7 7.7 0 010-3l-1.6-1.2 2-3.4 1.9.7a7.6 7.6 0 012-1.2l.3-2h4l.3 2a7.6 7.6 0 012 1.2l1.9-.7 2 3.4-1.6 1.2a7.7 7.7 0 010 3z',
  photo:
    'M4 7.5A2.5 2.5 0 016.5 5h11A2.5 2.5 0 0120 7.5v9a2.5 2.5 0 01-2.5 2.5h-11A2.5 2.5 0 014 16.5v-9zM4 15.5l4.2-4.2a1.5 1.5 0 012.1 0L15 16M13.5 14.5l1.7-1.7a1.5 1.5 0 012.1 0L20 15.5M15.5 9.5h.01',
  pencil: 'M4 20h4L19 9a2.8 2.8 0 00-4-4L4 16v4zM13.5 6.5l4 4',
  trash: 'M5 7h14M10 4h4M7 7l1 12.5a1.5 1.5 0 001.5 1.5h5a1.5 1.5 0 001.5-1.5L17 7M10.5 11v6M13.5 11v6',
  copy: 'M9 9.5A1.5 1.5 0 0110.5 8h8A1.5 1.5 0 0120 9.5v9a1.5 1.5 0 01-1.5 1.5h-8A1.5 1.5 0 019 18.5v-9zM15 8V5.5A1.5 1.5 0 0013.5 4h-8A1.5 1.5 0 004 5.5v9A1.5 1.5 0 005.5 16H9',
  folder:
    'M3.5 7.5A2 2 0 015.5 5.5h3.6a2 2 0 011.5.7l1.1 1.3h6.8a2 2 0 012 2v7a2 2 0 01-2 2h-13a2 2 0 01-2-2v-9z',
  doc: 'M7 3.5h6.5L18 8v11a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 016 19V5A1.5 1.5 0 017.5 3.5zM13 3.5V8.5h5M9 13h6M9 16.5h4',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4',
  globe:
    'M12 21a9 9 0 100-18 9 9 0 000 18zM3.5 9h17M3.5 15h17M12 3c-2.4 2.6-3.5 5.6-3.5 9s1.1 6.4 3.5 9c2.4-2.6 3.5-5.6 3.5-9S14.4 5.6 12 3z',
  list: 'M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01',
  terminal: 'M4.5 6.5l5 5-5 5M12 17.5h7.5',
  bolt: 'M13 3L5 13.5h6L10 21l8-10.5h-6L13 3z',
  shield: 'M12 3.5l7 2.8v5.2c0 4.3-3 7.7-7 9-4-1.3-7-4.7-7-9V6.3l7-2.8z',
  shieldAuto: 'M12 3.5l7 2.8v5.2c0 4.3-3 7.7-7 9-4-1.3-7-4.7-7-9V6.3l7-2.8zM9 12.2l2.1 2.1 4-4.2',
  question: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9.6 9.4a2.5 2.5 0 014.9.6c0 1.7-2.5 2.2-2.5 3.8M12 16.8h.01',
  sparkle:
    'M12 3.5l1.9 5.1a2.5 2.5 0 001.5 1.5l5.1 1.9-5.1 1.9a2.5 2.5 0 00-1.5 1.5L12 20.5l-1.9-5.1a2.5 2.5 0 00-1.5-1.5L3.5 12l5.1-1.9a2.5 2.5 0 001.5-1.5L12 3.5z',
  arrowDown: 'M12 5v14M6 13l6 6 6-6',
  share:
    'M12 15V3.5M8 7.5l4-4 4 4M7 11H6a1.5 1.5 0 00-1.5 1.5v6A1.5 1.5 0 006 20h12a1.5 1.5 0 001.5-1.5v-6A1.5 1.5 0 0018 11h-1',
  addSquare:
    'M4.5 7A2.5 2.5 0 017 4.5h10A2.5 2.5 0 0119.5 7v10a2.5 2.5 0 01-2.5 2.5H7A2.5 2.5 0 014.5 17V7zM12 8.5v7M8.5 12h7',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 18.5h.01M18.5 14h1.5',
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
  bell: 'M6 16.5V11a6 6 0 1112 0v5.5l1.5 2h-15l1.5-2zM10 20.5a2.2 2.2 0 004 0',
  moon: 'M19.5 14.5A7.5 7.5 0 019.5 4.5a7.5 7.5 0 1010 10z',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5.5M12 7.8h.01',
  warn: 'M12 4L2.8 19.5h18.4L12 4zM12 10v4.5M12 17.2h.01',
  refresh: 'M19.5 12a7.5 7.5 0 11-2.2-5.3M19.5 4.5v4h-4',
  textSize: 'M3.5 18L8 7l4.5 11M5 14.5h6M14.5 18l3-7.5 3 7.5M15.5 16h4',
  keyboard:
    'M3.5 7.5A1.5 1.5 0 015 6h14a1.5 1.5 0 011.5 1.5v9A1.5 1.5 0 0119 18H5a1.5 1.5 0 01-1.5-1.5v-9zM7 10h.01M10.3 10h.01M13.7 10h.01M17 10h.01M8 14.5h8',
  keyboardDown:
    'M3.5 5.5A1.5 1.5 0 015 4h14a1.5 1.5 0 011.5 1.5v7A1.5 1.5 0 0119 14H5a1.5 1.5 0 01-1.5-1.5v-7zM8 10.5h8M9 17.5l3 2.5 3-2.5',
  clipboard:
    'M9 4.5h6v2.5H9zM9 5.5H7A1.5 1.5 0 005.5 7v12.5A1.5 1.5 0 007 21h10a1.5 1.5 0 001.5-1.5V7A1.5 1.5 0 0017 5.5h-2',
  device: 'M8 3h8a2 2 0 012 2v14a2 2 0 01-2 2H8a2 2 0 01-2-2V5a2 2 0 012-2zM10.5 18h3',
  laptop: 'M5 6a1.5 1.5 0 011.5-1.5h11A1.5 1.5 0 0119 6v9H5V6zM2.5 18.5h19L20 15H4l-1.5 3.5z',
  code: 'M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5M13.5 5l-3 14',
  wave: 'M3 12h3l2.5-6 4 12 3-9 2 3H21',
  stop: 'M7 7h10v10H7z',
  history: 'M3.5 12a8.5 8.5 0 102.5-6M3.5 4.5V9h4.5M12 7.5V12l3 2',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 14.8a2.8 2.8 0 100-5.6 2.8 2.8 0 000 5.6z',
  archive: 'M4 5.5h16v3.5H4zM5.5 9v9A1.5 1.5 0 007 19.5h10a1.5 1.5 0 001.5-1.5V9M10 12.5h4',
  compose:
    'M12 4.5H6.5A2 2 0 004.5 6.5v11a2 2 0 002 2h11a2 2 0 002-2V12M17.6 3.9a2 2 0 012.8 2.8L12 15.1l-3.6.8.8-3.6 8.4-8.4z',
  sidebar:
    'M4.5 6.5A2 2 0 016.5 4.5h11a2 2 0 012 2v11a2 2 0 01-2 2h-11a2 2 0 01-2-2v-11zM9.5 4.5v15M6.6 8h.9M6.6 10.8h.9',
  slash: 'M15 4.5L9 19.5',
  split: 'M4.5 6.5A2 2 0 016.5 4.5h11a2 2 0 012 2v11a2 2 0 01-2 2h-11a2 2 0 01-2-2v-11zM12 4.5v15',
  camera:
    'M4 8.5A1.5 1.5 0 015.5 7h2.3l1.4-2h5.6l1.4 2h2.3A1.5 1.5 0 0120 8.5v9a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 17.5v-9zM12 16a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4z',
  download: 'M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14',
  exit: 'M14 4.5h4A1.5 1.5 0 0119.5 6v12a1.5 1.5 0 01-1.5 1.5h-4M10 16.5l4.5-4.5L10 7.5M14.5 12H4',
};

export type IconName = keyof typeof P;

export function Icon({
  name,
  size = 20,
  stroke = 2,
  class: cls,
  fill,
}: {
  name: IconName;
  size?: number;
  stroke?: number;
  class?: string;
  fill?: boolean;
}): JSX.Element {
  return (
    <svg
      class={cls ? `icon ${cls}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? 'currentColor' : 'none'}
      stroke="currentColor"
      stroke-width={stroke}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={P[name]} />
    </svg>
  );
}

/** A spinning activity indicator in the style of the system one. */
export function Spinner({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg class="spinner" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => (
        <rect
          key={i}
          x="11"
          y="2"
          width="2.2"
          height="6"
          rx="1.1"
          fill="currentColor"
          opacity={0.25 + (i / 8) * 0.75}
          transform={`rotate(${i * 45} 12 12)`}
        />
      ))}
    </svg>
  );
}
