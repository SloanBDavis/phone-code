/**
 * GET /api/sessions/<sessionId>/images/<id>[?w=<px>]
 *
 * Serves an image from a session's image store (images/store.ts). Needs
 * `Authorization: Bearer <device token>`; the /api transport and Host checks
 * in server.ts run before this. Images are content-addressed, so answers are
 * cached for a year as immutable (privately: never by shared caches). `?w=`
 * returns a WebP no wider than that (rounded up to a fixed size), made with
 * Bun.Image; the original is served when it is already narrow enough or the
 * thumbnail cannot be made.
 */
import type { DeviceStore } from '../auth/devices.ts';
import type { SessionManager } from '../sessions/manager.ts';
import { SECURITY_HEADERS } from './static.ts';

const ROUTE = /^\/api\/sessions\/([\w-]{1,128})\/images\/([0-9a-f]{32})$/;

export function isImageRoute(path: string): boolean {
  return path.startsWith('/api/sessions/');
}

function fail(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function serveImage(
  req: Request,
  url: URL,
  deps: { devices: DeviceStore; manager: SessionManager },
): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'method not allowed');
  const h = req.headers.get('authorization');
  const token = h?.startsWith('Bearer ') === true ? h.slice(7).trim() : undefined;
  if (token === undefined || deps.devices.authenticate(token) === undefined) return fail(401, 'unauthorized');
  const m = ROUTE.exec(url.pathname);
  const sessionId = m?.[1];
  const id = m?.[2];
  if (sessionId === undefined || id === undefined || deps.manager.get(sessionId) === undefined)
    return fail(404, 'not found');
  const wRaw = url.searchParams.get('w');
  let width: number | undefined;
  if (wRaw !== null) {
    width = Number(wRaw);
    if (!Number.isInteger(width) || width < 16 || width > 4096) return fail(400, 'w must be 16..4096');
  }
  const etag = `"${id}${width === undefined ? '' : `-w${width}`}"`;
  const headers = {
    ...SECURITY_HEADERS,
    // An image is never a document: no scripts even if a browser opens it directly.
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
    'Cache-Control': 'private, max-age=31536000, immutable',
    ETag: etag,
  };
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  const file = await deps.manager.images.get(sessionId, id, width);
  if (file === undefined) return fail(404, 'not found');
  return new Response(req.method === 'HEAD' ? null : file.body, {
    headers: { ...headers, 'Content-Type': file.mediaType },
  });
}
