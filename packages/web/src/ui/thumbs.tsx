import type { JSX } from 'preact';
import { usePicUrl, type Pic } from '../lib/images';
import { Icon } from './icons';
import { lazy } from './lazy';
import { openLayer } from './overlay';

const Viewer = lazy(() => import('../screens/viewer'));

/** Full screen, starting at `index`; swipe between the others. */
export function openViewer(pics: Pic[], index: number): void {
  void Viewer.preload();
  openLayer((close, closing) => <Viewer pics={pics} start={index} close={close} closing={closing} />);
}

const WIDTH = { bubble: 220, inline: 260, tool: 72 } as const;

function Thumb({
  pic,
  width,
  onOpen,
  progress,
}: {
  pic: Pic;
  width: number;
  onOpen: () => void;
  progress?: number | null;
}): JSX.Element {
  const [ref, url] = usePicUrl(pic, width);
  const r = pic.ref;
  const ratio = r?.width && r.height ? `${r.width} / ${r.height}` : undefined;
  return (
    <button
      type="button"
      ref={(el) => {
        ref.current = el;
      }}
      class={`thumb ${url && url !== 'error' ? 'loaded' : ''}`}
      style={ratio ? { aspectRatio: ratio } : undefined}
      aria-label={pic.name ? `Open ${pic.name}` : 'Open image'}
      data-testid="chat-image"
      onClick={onOpen}
    >
      {url === 'error' ? (
        <span class="thumb-missing">
          <Icon name="photo" size={18} />
        </span>
      ) : url ? (
        <img src={url} alt={pic.name ?? ''} decoding="async" />
      ) : null}
      {progress !== null && progress !== undefined && (
        <span class="thumb-progress" data-testid="upload-progress" style={{ '--p': String(progress) }} />
      )}
    </button>
  );
}

/** Images in a bubble, a message or a tool card: thumbnails, tap for the viewer. */
export function Thumbs({
  pics,
  variant,
  progress,
}: {
  pics: Pic[];
  variant: keyof typeof WIDTH;
  progress?: number | null;
}): JSX.Element | null {
  if (!pics.length) return null;
  return (
    <div class={`thumbs thumbs-${variant} n-${Math.min(pics.length, 3)}`}>
      {pics.map((p, i) => (
        <Thumb
          key={p.key}
          pic={p}
          width={WIDTH[variant]}
          progress={progress}
          onOpen={() => openViewer(pics, i)}
        />
      ))}
    </div>
  );
}
