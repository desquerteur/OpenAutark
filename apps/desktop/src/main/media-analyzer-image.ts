// B-058 G10: the page side of an image job in the media analyzer window (media-analyzer-page.ts serves
// it with the keyframe page; media-image.ts holds main's rules). The page decodes the job's blob with
// createImageBitmap (JPEG, PNG, WebP, GIF, BMP, AVIF, ICO; EXIF rotation applied) – an SVG through an
// <img> of the same origin, drawn whole at spec.svgPx (never through a source rectangle: that loses the text
// of an SVG without a size of its own) – cuts the region asked for (fractions of the image),
// scales it down to spec.maxPx on its longest edge (never up, except SVG) with high-quality resampling
// and encodes it: PNG for line art, screenshots and anything with transparency, else JPEG; a PNG over
// spec.maxBytes becomes a JPEG on white. It posts the one result, then done.
// Owns: the page side of the image job. Never: reaches anything but its own origin (the CSP and the
// session refuse it), keeps a bitmap after the job. imagePage must stay self-contained: it is served
// as its own source.

import type { ImageSpec } from './media-image.ts';

/** A decoded image the page can draw and must close. */
export interface PageBitmap { readonly width: number; readonly height: number; close(): void }

/** The parts of an <img> the page uses (SVG only). */
export interface PageImage { src: string; readonly naturalWidth: number; readonly naturalHeight: number; decode(): Promise<void> }

/** The parts of a 2D canvas the image job uses. */
export interface ImageCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): {
    imageSmoothingEnabled: boolean;
    imageSmoothingQuality: string;
    fillStyle: string;
    fillRect(x: number, y: number, width: number, height: number): void;
    drawImage(image: unknown, ...place: number[]): void;
    getImageData(x: number, y: number, width: number, height: number): { data: ArrayLike<number> };
  } | null;
  toBlob(callback: (blob: Blob | null) => void, type: string, quality: number): void;
}

/** The browser objects the image job uses (the window itself; tests pass fakes). */
export interface ImagePageEnv {
  document: { createElement(tag: 'canvas'): ImageCanvas; createElement(tag: 'img'): PageImage };
  fetch(input: string, init?: RequestInit): Promise<Response>;
  createImageBitmap(image: unknown, ...crop: unknown[]): Promise<PageBitmap>;
}

/** The image job, start to end; every failure is posted as its stage ('decode', 'too-large', 'encode'). */
export async function imagePage(env: ImagePageEnv, spec: ImageSpec): Promise<void> {
  const post = async (path: string, body: string | ArrayBuffer, type: string): Promise<void> => {
    const response = await env.fetch(path, { method: 'POST', body, headers: { 'Content-Type': type } });
    if (!response.ok) throw new Error('refused');
  };
  const bitmaps: PageBitmap[] = [];
  const closeAll = () => { for (const bitmap of bitmaps.splice(0)) { try { bitmap.close(); } catch { /* closed */ } } };
  let stage = 'decode';
  try {
    const response = await env.fetch('video');
    if (!response.ok) throw new Error(stage);
    const blob = await response.blob();
    if (blob.size > spec.inputBytes) { stage = 'too-large'; throw new Error(stage); }
    let source: unknown;
    let width: number;
    let height: number;
    if (spec.svg) {
      const image = env.document.createElement('img');
      image.src = 'video';
      await image.decode();
      width = image.naturalWidth || spec.svgPx; // an SVG without a size of its own: a square
      height = image.naturalHeight || spec.svgPx;
      source = image;
    } else {
      const bitmap = await env.createImageBitmap(blob);
      bitmaps.push(bitmap);
      width = bitmap.width;
      height = bitmap.height;
      source = bitmap;
    }
    if (!(width > 0 && height > 0)) throw new Error(stage);

    const region = spec.region ?? { x: 0, y: 0, w: 1, h: 1 };
    const sx = Math.min(width - 1, Math.floor(region.x * width));
    const sy = Math.min(height - 1, Math.floor(region.y * height));
    const sw = Math.max(1, Math.min(width - sx, Math.round(region.w * width)));
    const sh = Math.max(1, Math.min(height - sy, Math.round(region.h * height)));
    const longest = Math.max(sw, sh);
    const target = spec.svg ? Math.min(spec.maxPx, Math.max(longest, spec.svgPx)) : Math.min(spec.maxPx, longest);
    const dw = Math.max(1, Math.round((sw * target) / longest));
    const dh = Math.max(1, Math.round((sh * target) / longest));

    stage = 'encode';
    const canvas = env.document.createElement('canvas');
    canvas.width = dw;
    canvas.height = dh;
    const paint = canvas.getContext('2d');
    if (!paint) throw new Error(stage);
    paint.imageSmoothingEnabled = true;
    paint.imageSmoothingQuality = 'high';
    if (spec.svg) {
      // The whole picture at the target scale, shifted so the region lands on the canvas: Chromium drops an SVG's
      // text when an SVG without a size of its own is drawn through a source rectangle (live check 30.10.2026).
      const fx = dw / sw;
      const fy = dh / sh;
      paint.drawImage(source, -sx * fx, -sy * fy, width * fx, height * fy);
    } else if (dw !== sw || dh !== sh) {
      const small = await env.createImageBitmap(source, sx, sy, sw, sh, { resizeWidth: dw, resizeHeight: dh, resizeQuality: 'high' });
      bitmaps.push(small);
      paint.drawImage(small, 0, 0);
    } else {
      paint.drawImage(source, sx, sy, sw, sh, 0, 0, dw, dh);
    }
    closeAll();

    let alpha = false;
    if (!spec.opaque) {
      const pixels = paint.getImageData(0, 0, dw, dh).data;
      for (let i = 3; i < pixels.length && !alpha; i += 4) alpha = pixels[i] < 255;
    }
    const encode = (from: ImageCanvas, type: string, quality: number) => new Promise<Blob | null>((resolve) => from.toBlob(resolve, type, quality));
    let out = await encode(canvas, spec.lossless || alpha ? 'image/png' : 'image/jpeg', spec.quality);
    if (out && out.size > spec.maxBytes) {
      // Too large as PNG (a photo saved as PNG) or as JPEG: a JPEG on white, smaller still if needed.
      const flat = env.document.createElement('canvas');
      flat.width = dw;
      flat.height = dh;
      const white = flat.getContext('2d');
      if (!white) throw new Error(stage);
      white.fillStyle = '#ffffff';
      white.fillRect(0, 0, dw, dh);
      white.drawImage(canvas, 0, 0);
      out = await encode(flat, 'image/jpeg', spec.quality);
      if (out && out.size > spec.maxBytes) out = await encode(flat, 'image/jpeg', 0.6);
    }
    if (!out) throw new Error(stage);
    await post('image', await out.arrayBuffer(), out.type || 'application/octet-stream');
    await post('done', '{}', 'application/json');
  } catch {
    closeAll();
    await post('fail', JSON.stringify({ reason: stage }), 'application/json').catch(() => undefined);
  }
}
