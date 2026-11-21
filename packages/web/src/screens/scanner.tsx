import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { haptic } from '../lib/util';
import { GlassButton } from '../ui/glass';
import { Icon } from '../ui/icons';

interface Detector {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

declare global {
  interface Window {
    BarcodeDetector?: new (opts: { formats: string[] }) => Detector;
  }
}

/** In-app QR scanner: BarcodeDetector where available, jsQR otherwise. */
export default function Scanner({
  onResult,
  close,
}: {
  onResult: (text: string) => void;
  close: () => void;
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const resultRef = useRef(onResult);
  resultRef.current = onResult;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer = 0;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const start = async (): Promise<void> => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('This browser cannot use the camera. Paste the link instead.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
      } catch {
        setError('Camera access was not allowed. You can enable it in Settings, or paste the link instead.');
        return;
      }
      const v = videoRef.current;
      if (!v || stopped) return;
      v.srcObject = stream;
      await v.play().catch(() => undefined);

      let detector: Detector | null = null;
      if (window.BarcodeDetector) {
        try {
          detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        } catch {
          detector = null;
        }
      }
      const jsqr = detector ? null : (await import('jsqr')).default;

      const tick = async (): Promise<void> => {
        if (stopped) return;
        let text: string | null = null;
        try {
          if (v.readyState >= 2) {
            if (detector) {
              const codes = await detector.detect(v);
              text = codes[0]?.rawValue ?? null;
            } else if (jsqr && ctx) {
              const w = Math.min(640, v.videoWidth);
              const h = Math.round((v.videoHeight / v.videoWidth) * w);
              canvas.width = w;
              canvas.height = h;
              ctx.drawImage(v, 0, 0, w, h);
              const img = ctx.getImageData(0, 0, w, h);
              text = jsqr(img.data, w, h, { inversionAttempts: 'dontInvert' })?.data ?? null;
            }
          }
        } catch {
          text = null;
        }
        if (text) {
          haptic('success');
          resultRef.current(text);
          return;
        }
        timer = window.setTimeout(() => void tick(), 140);
      };
      void tick();
    };
    void start();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div class="scanner" data-testid="scanner">
      <div class="sheet-head">
        <span class="glass-btn glass-circle ghost" />
        <h2>Scan QR code</h2>
        <GlassButton icon="close" label="Close" onClick={close} testid="scanner-close" />
      </div>
      <div class="scanner-view">
        {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- live camera preview has no audio */}
        <video ref={videoRef} playsInline muted autoplay />
        <div class="scanner-frame" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        {error && (
          <div class="scanner-error" role="alert">
            <Icon name="warn" size={26} />
            <p>{error}</p>
          </div>
        )}
      </div>
      <p class="scanner-hint">
        Point at the QR code shown by <code class="cmd">npx phone-code</code>
      </p>
    </div>
  );
}
