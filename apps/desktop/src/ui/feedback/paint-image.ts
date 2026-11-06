// B-055: decoding a screenshot and flattening it with its marks into the report's JPEG (paint.ts
// rules: longest side ≤ EXPORT_MAX_SIDE, initial quality EXPORT_QUALITY). The editor paints at that export size;
// lower quality or a smaller flattened image keeps the encoded JPEG within the mailbox's image budget.
// Owns: canvas decode/encode. Never: keeps images or uploads them.

import { fitWithin } from './bridge.ts';
import { drawMarks, EXPORT_MAX_SIDE, EXPORT_MIME, EXPORT_QUALITY } from './paint.ts';
import type { PaintMark } from './paint.ts';

/** Leaves room for base64, text, diagnostics and encryption inside the 950 kB mailbox envelope. */
export const MAX_SCREENSHOT_BYTES = 600_000;
const JPEG_PREFIX = `data:${EXPORT_MIME};base64,`;
const PREPARE_ERROR = 'The screenshot could not be prepared. Try again.';

export async function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
}

/** The export (and editor) size of an image. */
export function exportSize(image: HTMLImageElement): { width: number; height: number } {
  return fitWithin(image.naturalWidth, image.naturalHeight, EXPORT_MAX_SIDE);
}

/** Draws the image scaled onto the canvas, then the marks. */
export function paintOnto(canvas: HTMLCanvasElement, image: HTMLImageElement, marks: readonly PaintMark[]): void {
  const context = canvas.getContext('2d');
  if (!context) throw new Error(PREPARE_ERROR);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  drawMarks(context, marks);
}

/** The flattened report image (JPEG data URL) of `src` with `marks` ([] = the original re-encoded). */
export async function flatten(src: string, marks: readonly PaintMark[]): Promise<string> {
  const image = await loadImage(src);
  const canvas = document.createElement('canvas');
  const size = exportSize(image);
  canvas.width = size.width;
  canvas.height = size.height;
  paintOnto(canvas, image, marks);
  const encode = (source: HTMLCanvasElement, quality: number): string | undefined => {
    const jpeg = source.toDataURL(EXPORT_MIME, quality);
    if (!jpeg.startsWith(JPEG_PREFIX)) throw new Error(PREPARE_ERROR);
    return (jpeg.length - JPEG_PREFIX.length) * 3 / 4 <= MAX_SCREENSHOT_BYTES ? jpeg : undefined;
  };
  for (const quality of [EXPORT_QUALITY, 0.7, 0.55]) {
    const jpeg = encode(canvas, quality);
    if (jpeg) return jpeg;
  }
  // Resize the already painted pixels, so marks keep covering the same parts of the screenshot.
  const smaller = document.createElement('canvas');
  for (const scale of [0.75, 0.5]) {
    smaller.width = Math.max(1, Math.round(canvas.width * scale));
    smaller.height = Math.max(1, Math.round(canvas.height * scale));
    const context = smaller.getContext('2d');
    if (!context) throw new Error(PREPARE_ERROR);
    context.drawImage(canvas, 0, 0, smaller.width, smaller.height);
    const jpeg = encode(smaller, 0.7);
    if (jpeg) return jpeg;
  }
  throw new Error('The screenshot is too large to prepare. Try a smaller window.');
}
