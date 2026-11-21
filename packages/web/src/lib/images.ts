import { useEffect, useRef, useState } from 'preact/hooks';
import type { ImageRef } from '@phone-code/protocol';
import { client } from './client';

/**
 * Images in a transcript are refs; the bytes come from the host over HTTP
 * with the bearer token, so they are fetched as blobs and shown through
 * object URLs. URLs are cached (and requests shared) per image and width.
 */

/** One image to show: bytes already here (`src`), or a ref to fetch for `sessionId`. */
export interface Pic {
  key: string;
  src?: string;
  ref?: ImageRef;
  sessionId?: string;
  name?: string;
}

const MAX = 200;
const urls = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

export function picsOf(sessionId: string, refs: ImageRef[] | undefined): Pic[] {
  return (refs ?? []).map((ref) => ({ key: `${sessionId}/${ref.id}`, ref, sessionId, name: ref.name }));
}

/** An object URL for a pic at a width (undefined: full size). */
export function picUrl(p: Pic, width?: number): Promise<string> {
  if (p.src) return Promise.resolve(p.src);
  if (!p.ref || !p.sessionId) return Promise.reject(new Error('No image'));
  const w = width ? Math.ceil((width * Math.min(3, devicePixelRatio || 1)) / 64) * 64 : undefined;
  const key = `${p.key}@${w ?? 'full'}`;
  const hit = urls.get(key);
  if (hit) return Promise.resolve(hit);
  let req = inflight.get(key);
  if (!req) {
    const { sessionId, ref } = p;
    req = client.image(sessionId, ref.id, w).then((blob) => {
      const url = URL.createObjectURL(blob);
      urls.set(key, url);
      if (urls.size > MAX) {
        const [oldKey, oldUrl] = urls.entries().next().value ?? [];
        if (oldKey && oldUrl) {
          urls.delete(oldKey);
          URL.revokeObjectURL(oldUrl);
        }
      }
      return url;
    });
    req.finally(() => inflight.delete(key)).catch(() => undefined);
    inflight.set(key, req);
  }
  return req;
}

/** The URL for a pic once it scrolls near the screen; 'error' when it cannot be loaded. */
export function usePicUrl(p: Pic, width?: number): [{ current: HTMLElement | null }, string | null] {
  const ref = useRef<HTMLElement | null>(null);
  const [url, setUrl] = useState<string | null>(p.src ?? null);
  useEffect(() => {
    if (p.src) {
      setUrl(p.src);
      return undefined;
    }
    let alive = true;
    const load = (): void => {
      picUrl(p, width).then(
        (u) => alive && setUrl(u),
        () => alive && setUrl('error'),
      );
    };
    const el = ref.current;
    if (!el || !('IntersectionObserver' in window)) {
      load();
      return () => {
        alive = false;
      };
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          load();
        }
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- a pic is identified by its key
  }, [p.key, p.src, width]);
  return [ref, url];
}
