/**
 * Image type and size from the bytes themselves. The client's (or the
 * agent's) claimed media type is never trusted: only PNG, JPEG, GIF and WebP
 * are accepted, recognized by their magic numbers.
 */

export type ImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface Sniffed {
  mediaType: ImageType;
  ext: 'png' | 'jpg' | 'gif' | 'webp';
  width?: number;
  height?: number;
}

function ascii(b: Uint8Array, at: number, s: string): boolean {
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
}

function u16be(b: Uint8Array, at: number): number {
  return ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
}
function u16le(b: Uint8Array, at: number): number {
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
}
function u24le(b: Uint8Array, at: number): number {
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
}
function u32be(b: Uint8Array, at: number): number {
  return (((b[at] ?? 0) << 24) >>> 0) + ((b[at + 1] ?? 0) << 16) + ((b[at + 2] ?? 0) << 8) + (b[at + 3] ?? 0);
}

function jpegSize(b: Uint8Array): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1] ?? 0;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = u16be(b, i + 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    i += 2 + len;
  }
  return undefined;
}

function webpSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (ascii(b, 12, 'VP8X')) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  if (ascii(b, 12, 'VP8L')) {
    const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, 'VP8 ')) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  return undefined;
}

/** The image type of `b`, or undefined when it is not one of the four accepted formats. */
export function sniffImage(b: Uint8Array): Sniffed | undefined {
  let out: Sniffed | undefined;
  let size: { width: number; height: number } | undefined;
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 'PNG\r\n\u001A\n')) {
    out = { mediaType: 'image/png', ext: 'png' };
    if (ascii(b, 12, 'IHDR')) size = { width: u32be(b, 16), height: u32be(b, 20) };
  } else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    out = { mediaType: 'image/jpeg', ext: 'jpg' };
    size = jpegSize(b);
  } else if (b.length >= 10 && (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'))) {
    out = { mediaType: 'image/gif', ext: 'gif' };
    size = { width: u16le(b, 6), height: u16le(b, 8) };
  } else if (b.length >= 30 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) {
    out = { mediaType: 'image/webp', ext: 'webp' };
    size = webpSize(b);
  }
  if (out === undefined) return undefined;
  if (size !== undefined && size.width > 0 && size.height > 0) {
    out.width = size.width;
    out.height = size.height;
  }
  return out;
}

export const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp)$/i;
