/**
 * Liquid Glass refraction for Chromium: per-size SVG displacement filters
 * used through `backdrop-filter: url(#…)`. WebKit cannot reference SVG
 * filters from backdrop-filter, so it gets the layered blur fallback in CSS.
 *
 * A filter's map encodes, for each pixel near the rounded edge, a vector that
 * points toward the center; the displacement samples the backdrop from
 * further inside, which bends content at the rim like a thick glass lens.
 */

const NS = 'http://www.w3.org/2000/svg';
let defs: SVGDefsElement | null = null;
const cache = new Map<string, string>();
let n = 0;

export const refractionSupported = (): boolean => {
  const ua = navigator.userAgent;
  const chromium = /Chrome\/\d+/.test(ua) && !/CriOS|EdgiOS|FxiOS/.test(ua);
  const ios = /iPhone|iPad|iPod/.test(ua);
  return (
    chromium &&
    !ios &&
    !matchMedia('(prefers-reduced-transparency: reduce)').matches &&
    !matchMedia('(prefers-contrast: more)').matches
  );
};

function ensureDefs(): SVGDefsElement {
  if (defs) return defs;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  defs = document.createElementNS(NS, 'defs');
  svg.appendChild(defs);
  document.body.appendChild(svg);
  return defs;
}

function makeMap(w: number, h: number, r: number, bezel: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(w, h);
  const cx = w / 2;
  const cy = h / 2;
  const hx = w / 2 - r;
  const hy = h / 2 - r;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - cx;
      const py = y + 0.5 - cy;
      const qx = Math.abs(px) - hx;
      const qy = Math.abs(py) - hy;
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      const outside = Math.hypot(ox, oy);
      const dist = r - (outside + Math.min(Math.max(qx, qy), 0)); // distance from edge, inside > 0
      let nx = 0;
      let ny = 0;
      if (qx > 0 && qy > 0) {
        nx = (ox / (outside || 1)) * Math.sign(px);
        ny = (oy / (outside || 1)) * Math.sign(py);
      } else if (qx > qy) nx = Math.sign(px);
      else ny = Math.sign(py);
      const t = Math.min(Math.max(1 - dist / bezel, 0), 1);
      const m = t * t * (3 - 2 * t);
      const i = (y * w + x) * 4;
      img.data[i] = Math.round(127.5 - nx * m * 127);
      img.data[i + 1] = Math.round(127.5 - ny * m * 127);
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL();
}

/** Returns a `url(#id)` for a filter matching this box, creating it once per size. */
export function refractionFilter(w: number, h: number, radius: number): string {
  const W = Math.max(1, Math.round(w));
  const H = Math.max(1, Math.round(h));
  const r = Math.min(Math.round(radius), Math.floor(Math.min(W, H) / 2));
  const key = `${W}x${H}r${r}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const bezel = Math.max(6, Math.min(r * 0.9, 22, Math.min(W, H) / 2));
  const scale = Math.max(8, Math.min(bezel * 1.4, 30));
  const id = `lg${n++}`;
  const filter = document.createElementNS(NS, 'filter');
  filter.id = id;
  filter.setAttribute('x', '0');
  filter.setAttribute('y', '0');
  filter.setAttribute('width', String(W));
  filter.setAttribute('height', String(H));
  filter.setAttribute('filterUnits', 'userSpaceOnUse');
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  const image = document.createElementNS(NS, 'feImage');
  image.setAttribute('href', makeMap(W, H, r, bezel));
  image.setAttribute('x', '0');
  image.setAttribute('y', '0');
  image.setAttribute('width', String(W));
  image.setAttribute('height', String(H));
  image.setAttribute('preserveAspectRatio', 'none');
  image.setAttribute('result', 'map');
  const disp = document.createElementNS(NS, 'feDisplacementMap');
  disp.setAttribute('in', 'SourceGraphic');
  disp.setAttribute('in2', 'map');
  disp.setAttribute('scale', String(scale));
  disp.setAttribute('xChannelSelector', 'R');
  disp.setAttribute('yChannelSelector', 'G');
  filter.append(image, disp);
  ensureDefs().appendChild(filter);
  const url = `url(#${id})`;
  cache.set(key, url);
  return url;
}

/**
 * Attaches refraction to an element and keeps it matched to the element's
 * size. Returns a cleanup function. No-op where unsupported.
 */
export function attachRefraction(el: HTMLElement): () => void {
  if (!refractionSupported()) return () => undefined;
  let frame = 0;
  const update = (): void => {
    frame = 0;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return;
    const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    el.style.setProperty('--lg', refractionFilter(el.offsetWidth, el.offsetHeight, radius));
  };
  const ro = new ResizeObserver(() => {
    if (!frame) frame = requestAnimationFrame(update);
  });
  ro.observe(el);
  return () => {
    ro.disconnect();
    cancelAnimationFrame(frame);
  };
}
