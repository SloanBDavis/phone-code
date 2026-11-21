import { isRecord, parseJson } from '../util/guards.ts';
import type { Asset, WebAssets } from './web-assets.ts';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_STORE = 'no-store, must-revalidate';
const REVALIDATE = 'no-cache';

/** Bundler output with a content hash in the name, e.g. index-B2x9_aZq.js. */
const HASHED = /[.-][A-Za-z0-9_-]{8,}\.(?:js|mjs|css|woff2?|png|svg|jpe?g|webp|wasm|map)$/;
/** Files whose staleness breaks updates: entry document, service worker, manifest. */
const NEVER_CACHE =
  /^(?:index\.html|sw\.js|service-worker\.js|registerSW\.js|workbox-[^/]*\.js|manifest\.webmanifest)$/;

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
};

function cacheControl(path: string): string {
  if (NEVER_CACHE.test(path)) return NO_STORE;
  if (path.startsWith('assets/') || HASHED.test(path)) return IMMUTABLE;
  return REVALIDATE;
}

function acceptsBrotli(req: Request): boolean {
  return /\bbr\b/.test(req.headers.get('accept-encoding') ?? '');
}

function respond(req: Request, path: string, asset: Asset): Response {
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    'Content-Type': asset.type,
    'Cache-Control': cacheControl(path),
    ETag: asset.etag,
  };
  if (asset.br !== undefined) headers['Vary'] = 'Accept-Encoding';
  if (req.headers.get('if-none-match') === asset.etag) return new Response(null, { status: 304, headers });
  if (asset.br !== undefined && acceptsBrotli(req)) {
    headers['Content-Encoding'] = 'br';
    return new Response(req.method === 'HEAD' ? null : asset.br, { headers });
  }
  // Bun streams a BunFile with sendfile(2): no copy through JS.
  return new Response(req.method === 'HEAD' ? null : asset.file, { headers });
}

const PLACEHOLDER = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>phone-code</title><body style="font:16px system-ui;padding:24px;background:#111;color:#eee">
<h1>phone-code</h1><p>The daemon is running, but the web app has not been built.</p>
<p>Run <code>bun run --filter @phone-code/web build</code> and reload.</p></body>`;

/** Serve a GET/HEAD for the web app, with SPA fallback to index.html. */
export function serveStatic(req: Request, pathname: string, assets: WebAssets): Response {
  let path: string;
  try {
    path = decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  if (path === '') path = 'index.html';
  const asset = assets.get(path) ?? assets.get(`${path}/index.html`.replace(/^\//, ''));
  if (asset !== undefined) return respond(req, path, asset);
  const last = path.slice(path.lastIndexOf('/') + 1);
  const looksLikeFile = last.includes('.');
  const index = assets.get('index.html');
  if (!looksLikeFile && index !== undefined) return respond(req, 'index.html', index);
  if (index === undefined && !looksLikeFile) {
    return new Response(PLACEHOLDER, {
      headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': NO_STORE },
    });
  }
  return new Response('Not found', { status: 404, headers: SECURITY_HEADERS });
}

// ------------------------------------------------------------ manifest

interface ManifestIcon {
  src: string;
  sizes?: string;
  type?: string;
  purpose?: string;
}

function iconsFrom(assets: WebAssets): ManifestIcon[] {
  const icons: ManifestIcon[] = [];
  for (const path of assets.paths()) {
    if (!/(?:^|\/)(?:icons?\/|[^/]*icon)[^/]*\.(?:png|svg|webp)$/i.test(path)) continue;
    if (/favicon/i.test(path)) continue;
    const size = /(\d{2,4})(?:x\d{2,4})?\.\w+$/.exec(path)?.[1];
    const icon: ManifestIcon = { src: `/${path}`, type: assets.get(path)?.type.split(';')[0] ?? 'image/png' };
    if (path.endsWith('.svg')) icon.sizes = 'any';
    else if (size !== undefined) icon.sizes = `${size}x${size}`;
    if (/maskable/i.test(path)) icon.purpose = 'maskable';
    icons.push(icon);
  }
  return icons;
}

/**
 * Dynamic manifest. The web app's own manifest.webmanifest (if any) is the
 * base; `?h=<handoff code>` is carried into start_url so a freshly installed
 * Home Screen app can redeem it (iOS gives it storage separate from Safari).
 */
export async function serveManifest(url: URL, assets: WebAssets): Promise<Response> {
  let base: Record<string, unknown> = {};
  const own = assets.get('manifest.webmanifest');
  if (own !== undefined) {
    try {
      const parsed = parseJson(await own.file.text());
      if (isRecord(parsed)) base = parsed;
    } catch {
      // Fall back to the generated defaults.
    }
  }
  const manifest: Record<string, unknown> = {
    name: 'phone-code',
    short_name: 'phone-code',
    description: 'Your terminal, Claude Code and Codex on your phone.',
    display: 'standalone',
    background_color: '#0b0b0c',
    theme_color: '#0b0b0c',
    scope: '/',
    id: '/',
    start_url: '/',
    icons: iconsFrom(assets),
    ...base,
  };
  const code = url.searchParams.get('h');
  if (code !== null && /^[A-Za-z0-9-]{4,64}$/.test(code)) {
    manifest['start_url'] = `/?h=${encodeURIComponent(code)}`;
  }
  return new Response(JSON.stringify(manifest), {
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': NO_STORE,
    },
  });
}
