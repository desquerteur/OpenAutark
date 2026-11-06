// B-058 G10: pure rules of preparing a stored image for a model in the media analyzer (media-analyzer.ts
// runs the job, media-analyzer-image.ts is the page side): the checked request of the host op
// media.image (longest edge, a region as fractions), the image type from the file's first bytes (HEIC
// and HEIF, which Chromium cannot decode, are named so they are refused before a window opens), the
// pixel count from a PNG/JPEG header (decompression bombs are refused), the job's page spec and the
// check of the encoded result the page posts back (a real PNG or JPEG within the edge and the bytes).
// Owns: these rules. Never: touches files, windows, timers or the network.

import { IMAGE_LIMITS } from '../shared/api/host-bridge.ts';
import type { ImageRegion, NormalizedImage } from '../shared/api/host-bridge.ts';
import { WorkforceError } from '../shared/errors.ts';
import { jpegSize } from './media-keyframes.ts';
import { isBlobId, sniffMime } from './protocols/rules.ts';

export interface ImageRequest { fileId: string; mime?: string; maxPx: number; region?: ImageRegion }

/** What the page is told for an image job (media-analyzer-image.ts). */
export interface ImageSpec {
  task: 'image';
  maxPx: number;
  region: ImageRegion | null;
  /** SVG is drawn from an <img> at svgPx on its longest edge (vector art has no pixel size of its own), within maxPx. */
  svg: boolean;
  svgPx: number;
  /** Line art and screenshots stay PNG; a JPEG source has no transparency to look for. */
  lossless: boolean;
  opaque: boolean;
  quality: number;
  maxBytes: number;
  inputBytes: number;
}

export const MIN_PX = 16;
/** Bytes of the file read before a job (a JPEG's frame header can sit behind a large EXIF block). */
export const IMAGE_HEAD_BYTES = 256 * 1024;
/** Larger images are refused before decoding (about 400 MB of pixels). */
export const MAX_PIXELS = 100_000_000;
/** Larger image files are refused before a window opens (and by the page). */
export const INPUT_BYTES = 100 * 1024 * 1024;
const SVG_PX = 1024;
const QUALITY = 0.85;
const IMAGE_MIME = /^image\/[a-z0-9][a-z0-9.+-]{0,63}$/;
const LOSSLESS: ReadonlySet<string> = new Set(['image/png', 'image/gif', 'image/bmp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon']);
const HEIF_BRANDS = /^(?:heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/;

const bad = (message: string) => new WorkforceError('bad_request', message);
const fraction = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** The host op's arguments, checked: a blob id, the longest edge (16–1568, default 1568), a region or none, an image MIME type or none. */
export function imageRequest(args: { fileId?: unknown; mime?: unknown; maxPx?: unknown; region?: unknown }): ImageRequest {
  if (typeof args.fileId !== 'string' || !isBlobId(args.fileId)) throw bad('Invalid file id.');
  const maxPx = args.maxPx ?? IMAGE_LIMITS.maxPx;
  if (typeof maxPx !== 'number' || !Number.isSafeInteger(maxPx) || maxPx < MIN_PX || maxPx > IMAGE_LIMITS.maxPx) {
    throw bad(`maxPx must be a whole number from ${MIN_PX} to ${IMAGE_LIMITS.maxPx}.`);
  }
  const mime = typeof args.mime === 'string' ? args.mime.split(';')[0].trim().toLowerCase() : '';
  return { fileId: args.fileId, maxPx, ...(args.region === undefined ? {} : { region: regionOf(args.region) }), ...(IMAGE_MIME.test(mime) ? { mime } : {}) };
}

/** A region as fractions of the image: x, y top left in [0, 1), w, h > 0 and inside the image. */
function regionOf(value: unknown): ImageRegion {
  const r = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const { x, y, w, h } = r;
  if (!fraction(x) || !fraction(y) || !fraction(w) || !fraction(h) || x >= 1 || y >= 1 || w <= 0 || h <= 0 || x + w > 1.000001 || y + h > 1.000001) {
    throw bad('The region must be fractions 0..1 of the image: x and y its top left corner, w and h its size, inside the image.');
  }
  return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
}

/** HEIC/HEIF photos: Chromium has no decoder for them. */
export function isHeif(mime: string): boolean {
  return /^image\/hei[cf](?:-sequence)?$/.test(mime);
}

/** The image type from the file's first bytes (HEIF and AVIF by their brand, BMP, else rules.ts sniffMime); '' when unknown. */
export function imageMime(head: Uint8Array): string {
  const ascii = (at: number, length: number) => String.fromCharCode(...head.subarray(at, at + length));
  if (head.length >= 12 && ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (HEIF_BRANDS.test(brand)) return 'image/heic';
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) return 'image/bmp';
  const sniffed = sniffMime(head);
  return sniffed.startsWith('image/') ? sniffed : '';
}

/** Width and height from a PNG's IHDR, or null when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, i) => bytes[i] !== byte) || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Pixels of a PNG or JPEG from its header (undefined for other types or when the header is not in `head`). */
export function headerPixels(head: Uint8Array): number | undefined {
  const size = pngSize(head) ?? jpegSize(head);
  return size ? size.width * size.height : undefined;
}

export function imageSpec(request: ImageRequest, mime: string): ImageSpec {
  return {
    task: 'image', maxPx: request.maxPx, region: request.region ?? null, svg: mime === 'image/svg+xml', svgPx: SVG_PX,
    lossless: LOSSLESS.has(mime), opaque: mime === 'image/jpeg', quality: QUALITY, maxBytes: IMAGE_LIMITS.maxBytes, inputBytes: INPUT_BYTES,
  };
}

/** The page's encoded result, checked: a PNG or JPEG of at most maxBytes whose header size is within maxPx; else null. */
export function encodedImage(bytes: Uint8Array, maxPx: number): Omit<NormalizedImage, 'data'> | null {
  if (!bytes.length || bytes.length > IMAGE_LIMITS.maxBytes) return null;
  const png = pngSize(bytes);
  const size = png ?? jpegSize(bytes);
  if (!size || size.width > maxPx || size.height > maxPx) return null;
  return { mime: png ? 'image/png' : 'image/jpeg', width: size.width, height: size.height };
}
