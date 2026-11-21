import type { Attachment } from '@phone-code/protocol';

const MAX_EDGE = 1568; // what vision models use at full fidelity
const QUALITY = 0.85;

/** Downscales a photo to a sane size and re-encodes it as JPEG (keeps PNG for screenshots with alpha). */
export async function downscaleImage(file: File): Promise<Attachment> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const png = file.type === 'image/png' && scale === 1 && file.size < 1_500_000;
  const mediaType = png ? 'image/png' : 'image/jpeg';
  const dataUrl = canvas.toDataURL(mediaType, QUALITY);
  return {
    mediaType,
    name: file.name.replace(/\.\w+$/, png ? '.png' : '.jpg'),
    data: dataUrl.slice(dataUrl.indexOf(',') + 1),
  };
}
