// B-058 G10 – images bound for a model, normalized in one place: the chat attachments of an engine turn
// (visionInputs, agents/turn-prepare.ts) and what media.view shows (visionImage, visionFile). An image goes as it
// is when every engine takes it: PNG, JPEG, WebP or a still GIF of at most VISION_LIMITS.passBytes (5 MB as base64 –
// Anthropic's per-image limit; OpenAI takes 20 MB) and IMAGE_LIMITS.maxPx on its longest edge. Any other image
// (SVG, BMP, TIFF, AVIF, HEIC, an animated GIF, a big photo) gets a JPEG/PNG copy ≤ IMAGE_LIMITS.maxPx through the host's media
// analyzer (Host.media.image, main) – headless, a PNG is shrunk here (computer/png.ts, read-only use) – and a whole
// image's copy is kept by blob id in <temp>/vision/ (media/vision-cache.ts, bounded; the oldest go). Without a
// copy, an image that still meets every engine's hard limit (VISION_LIMITS.fallbackPx: Anthropic's 2000 px once a
// request holds many images) goes as it is; anything else becomes a text line that names media.view. A turn waits at
// most VISION_LIMITS.turnMs for its copies (a copy finished later is still cached); a copy over passBytes is made once
// more, smaller.
// A workspace or PC file that needs the analyzer is stored as a blob first and queued for clean-up right away
// (files/cleanup.ts: it goes once it is a minute old and nothing uses it).
// Owns: these limits, when a copy is made and the line for an image that cannot go. Never: changes a stored blob, reads more
// than VISION_LIMITS.readBytes of one image, decodes a PNG above VISION_LIMITS.decodePixels here, or fails a turn
// over an image (a line instead).

import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { IMAGE_LIMITS, type ImageRegion, type NormalizedImage } from '../../shared/api/host-bridge.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { RuntimeServices } from '../contracts.ts';
import { reclaimerOf } from '../files/cleanup.ts';
import { cachedCopy as cached, storeCopy as store } from './vision-cache.ts';
import { detectMime, imageSize } from '../files/mime.ts';
import { decodePng, downscale, encodePng, pngSize, type RawImage } from '../computer/png.ts';
import { fitWithin } from '../computer/geometry.ts';

export const VISION_LIMITS = {
  maxPx: IMAGE_LIMITS.maxPx,
  /** Raw bytes of an image that goes as it is (3.75 MB = 5 MB as base64). */
  passBytes: 3_750_000,
  /** The longest edge every engine still takes when no copy can be made. */
  fallbackPx: 2000,
  /** The most bytes of one image read for a model. */
  readBytes: 40 * 1024 * 1024,
  /** The largest PNG decoded here (headless shrinking and cutting; ~64 MB of pixels). */
  decodePixels: 16_000_000,
  /** The longest one turn waits for its images' copies (the analyzer may be busy with recordings or videos). */
  turnMs: 60_000,
} as const;

/** The image types every engine reads (Anthropic, OpenAI, Gemini, Codex). */
export const VISION_MIMES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export type VisionServices = Pick<RuntimeServices, 'files' | 'paths' | 'log' | 'host'>;

/** One turn input part for an image (engines/types.ts TurnInputItem): the image, or the line said instead. */
export type VisionItem = { type: 'image'; path: string; mime: string } | { type: 'text'; text: string };

export interface ImageFacts { mime: string; bytes: number; width?: number; height?: number; animated?: boolean }

/** An image for a model: its bytes and what was done to them. */
export interface ShownImage {
  data: Uint8Array;
  mime: string;
  width?: number;
  height?: number;
  /** A JPEG/PNG copy, not the original bytes. */
  converted: boolean;
  /** Only the asked region (else the whole image). */
  cut: boolean;
}

const HEADLESS = 'converting this image needs the desktop app (this runtime has no media analyzer)';
/** Read for an image's size (a JPEG's SOF may sit behind large APP segments) and a GIF's animation mark. */
const HEADER_BYTES = 256 * 1024;

/** Lower case without parameters; image/jpg and image/pjpeg read as image/jpeg. */
export function visionMime(mime: string): string {
  const base = mime.split(';')[0].trim().toLowerCase();
  return base === 'image/jpg' || base === 'image/pjpeg' ? 'image/jpeg' : base;
}

/** True when the image goes to every engine as it is (`edge`: the longest edge allowed). Unknown sizes count as fitting. */
export function fitsAsIs(facts: ImageFacts, edge: number = VISION_LIMITS.maxPx): boolean {
  if (!VISION_MIMES.has(visionMime(facts.mime)) || facts.bytes > VISION_LIMITS.passBytes) return false;
  if (facts.animated && edge <= VISION_LIMITS.maxPx) return false; // its first frame as a copy: OpenAI reads still GIFs only
  return !facts.width || !facts.height || Math.max(facts.width, facts.height) <= edge;
}

/** The blob id of a stored file's path (s.files.path), else undefined. */
function blobId(s: VisionServices, file: string): string | undefined {
  const id = /([a-f0-9]{64})$/i.exec(path.basename(file))?.[1]?.toLowerCase();
  if (!id) return undefined;
  try { return path.resolve(s.files.path(id)) === path.resolve(file) ? id : undefined; } catch { return undefined; }
}

async function readBounded(file: string): Promise<Uint8Array> {
  const info = await stat(file);
  if (info.size > VISION_LIMITS.readBytes) throw new WorkforceError('bad_request', `the image is over ${VISION_LIMITS.readBytes / 1024 / 1024} MB`);
  return new Uint8Array(await readFile(file));
}

/** A GIF with the looping extension (an animation). */
const animatedGif = (bytes: Uint8Array, mime: string) => mime === 'image/gif' && Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes('NETSCAPE2.0', 0, 'latin1');

/** The first HEADER_BYTES of a file; empty when it cannot be read (a turn never fails over an image). */
async function headOf(file: string): Promise<Uint8Array> {
  const handle = await open(file, 'r').catch(() => undefined);
  if (!handle) return new Uint8Array(0);
  try {
    const head = new Uint8Array(HEADER_BYTES);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead);
  } catch { return new Uint8Array(0); } finally { await handle.close().catch(() => undefined); }
}

const headFacts = (head: Uint8Array, mime: string) => ({ ...imageSize(head, mime), ...(animatedGif(head, mime) ? { animated: true } : {}) });

/** Size and dimensions of an image file (the files row first, else its header); undefined when it is missing. */
async function factsOf(s: VisionServices, file: string, fileId: string | undefined, mime: string): Promise<ImageFacts | undefined> {
  let ref: ReturnType<VisionServices['files']['get']>;
  try { ref = fileId ? s.files.get(fileId) : undefined; } catch { ref = undefined; }
  const bytes = ref?.size ?? (await stat(file).catch(() => undefined))?.size;
  if (bytes === undefined) return undefined;
  const known = { width: ref?.width, height: ref?.height };
  if (mime !== 'image/gif' && ((known.width && known.height) || !VISION_MIMES.has(mime))) return { mime, bytes, ...known };
  return { mime, bytes, ...known, ...headFacts(await headOf(file), mime) };
}

/** One region (fractions 0..1) of decoded pixels, at least one pixel. */
function crop(image: RawImage, r: ImageRegion): RawImage {
  const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
  const x0 = clamp(Math.floor(r.x * image.width), 0, image.width - 1);
  const y0 = clamp(Math.floor(r.y * image.height), 0, image.height - 1);
  const x1 = clamp(Math.ceil((r.x + r.w) * image.width), x0 + 1, image.width);
  const y1 = clamp(Math.ceil((r.y + r.h) * image.height), y0 + 1, image.height);
  const width = x1 - x0;
  const ch = image.channels;
  const pixels = new Uint8Array(width * (y1 - y0) * ch);
  for (let y = y0; y < y1; y++) pixels.set(image.pixels.subarray((y * image.width + x0) * ch, (y * image.width + x1) * ch), (y - y0) * width * ch);
  return { width, height: y1 - y0, channels: ch, pixels };
}

/** Headless: a PNG shrunk (and cut) here to `edge`; undefined for PNGs computer/png.ts does not read or that are too big. */
export function pngHere(data: Uint8Array, region?: ImageRegion, edge: number = VISION_LIMITS.maxPx): NormalizedImage | undefined {
  const size = pngSize(data);
  if (!size || size.width * size.height > VISION_LIMITS.decodePixels) return undefined;
  const raw = decodePng(data);
  if (!raw) return undefined;
  const part = region ? crop(raw, region) : raw;
  const fit = fitWithin(part.width, part.height, edge);
  const small = fit.width === part.width && fit.height === part.height ? part : downscale(part, fit.width, fit.height);
  return { data: encodePng(small), mime: 'image/png', width: small.width, height: small.height };
}

/** The edge for a second, smaller copy of one over passBytes (its bytes grow with its pixels), at least 512 px. */
export const smallerEdge = (image: Pick<NormalizedImage, 'data' | 'width' | 'height'>) =>
  Math.max(512, Math.floor(Math.max(image.width, image.height) * Math.sqrt(VISION_LIMITS.passBytes / image.data.length) * 0.9));

/**
 * A JPEG/PNG copy ≤ maxPx of a stored image (or of its region): the host's media analyzer, else – a PNG – here. A copy
 * over passBytes (a photo-like PNG: the analyzer keeps PNG up to IMAGE_LIMITS.maxBytes, over Anthropic's 5 MB as
 * base64) is made once more at smallerEdge.
 */
async function convert(s: VisionServices, input: { fileId: string; mime: string; region?: ImageRegion; read: () => Promise<Uint8Array> }): Promise<NormalizedImage> {
  const host = s.host?.media?.image;
  let failed: unknown;
  if (host) {
    const ask = (maxPx: number) => host({ fileId: input.fileId, mime: input.mime, maxPx, ...(input.region ? { region: input.region } : {}) });
    try {
      const image = await ask(VISION_LIMITS.maxPx);
      return image.data.length > VISION_LIMITS.passBytes ? await ask(smallerEdge(image)) : image;
    } catch (error) { failed = error; }
  }
  if (input.mime === 'image/png') {
    const data = await input.read();
    const png = pngHere(data, input.region);
    if (png) return png.data.length > VISION_LIMITS.passBytes ? pngHere(data, input.region, smallerEdge(png)) ?? png : png;
  }
  if (failed instanceof WorkforceError) throw failed;
  throw new WorkforceError('unavailable', host ? 'the image could not be converted' : HEADLESS);
}

const reason = (error: unknown) => (error instanceof WorkforceError ? error.message : 'the image could not be read').replace(/[.\s]+$/, '');

/**
 * A stored image (blob id) for a model, whole or one region: the bytes as they are when they fit, else a converted
 * copy (a whole image's is cached); when no copy can be made, the original if it still meets the hard limit (cut
 * false: the region could not be cut). Throws a WorkforceError when nothing can be shown.
 */
export async function visionImage(s: VisionServices, input: { fileId: string; mime: string; region?: ImageRegion }): Promise<ShownImage> {
  const mime = visionMime(input.mime);
  const file = s.files.path(input.fileId);
  const facts = await factsOf(s, file, input.fileId, mime);
  if (!facts) throw new WorkforceError('not_found', 'The stored image is missing.');
  const original = async (): Promise<ShownImage> => ({ data: await readBounded(file), mime, width: facts.width, height: facts.height, converted: false, cut: false });
  if (!input.region && fitsAsIs(facts)) return original();
  const hit = input.region ? undefined : await cached(s, input.fileId);
  if (hit) {
    const data = new Uint8Array(await readFile(hit.path));
    return { data, mime: hit.mime, ...imageSize(data, hit.mime), converted: true, cut: false };
  }
  try {
    const image = await convert(s, { fileId: input.fileId, mime, region: input.region, read: () => readBounded(file) });
    if (!input.region) await store(s, input.fileId, image).catch((error) => s.log.warn('caching a converted image failed', { error: String(error) }));
    return { ...image, converted: true, cut: Boolean(input.region) };
  } catch (error) {
    if (fitsAsIs(facts, VISION_LIMITS.fallbackPx)) return original();
    throw new WorkforceError(error instanceof WorkforceError ? error.code : 'unavailable', `This image cannot be shown: ${reason(error)}.`);
  }
}

/**
 * An image file outside the store (workspace, PC – the caller checked the path), judged by its first bytes: as it is
 * when it fits; else stored as a blob for the analyzer (queued for clean-up) – headless, a PNG is shrunk here (never
 * in this process while the analyzer can do it: a big PNG would hold up every agent for seconds). Throws a
 * WorkforceError (not an image, too big …).
 */
export async function visionFile(s: VisionServices, file: string): Promise<ShownImage & { name: string; bytes: number }> {
  const name = path.basename(file);
  const head = await headOf(file);
  const mime = visionMime(detectMime(head.subarray(0, 64 * 1024), name));
  if (!mime.startsWith('image/')) throw new WorkforceError('bad_request', 'This file is not an image.');
  const bytes = (await stat(file)).size;
  if (bytes > VISION_LIMITS.readBytes) throw new WorkforceError('bad_request', `This image cannot be shown: it is over ${VISION_LIMITS.readBytes / 1024 / 1024} MB.`);
  const size = imageSize(head, mime);
  const facts: ImageFacts = { mime, bytes, ...headFacts(head, mime) };
  const asIs = async () => ({ data: await readBounded(file), mime, ...size, converted: false, cut: false, name, bytes });
  if (fitsAsIs(facts)) return asIs();
  if (s.host?.media?.image) {
    const ref = await s.files.putPath(file, mime);
    try {
      return { ...await visionImage(s, { fileId: ref.id, mime }), name, bytes };
    } finally {
      reclaimerOf(s.files)?.reclaim([ref.id]); // goes once it is a minute old, unless a chat or the library uses those bytes
    }
  }
  const png = mime === 'image/png' ? pngHere(await readBounded(file)) : undefined;
  if (png) return { ...png, converted: true, cut: false, name, bytes };
  if (fitsAsIs(facts, VISION_LIMITS.fallbackPx)) return asIs();
  throw new WorkforceError('unavailable', `This image cannot be shown: ${HEADLESS}.`);
}

/** The line a turn gets for an image it cannot be sent. */
export function unsentLine(name: string, why: string): string {
  return `(Image "${name}" is not attached for me to see: ${why}. media.view with its stored path tries again.)`;
}

const BUSY = 'the media analyzer is busy';

/** A turn's wait for its copies: until `deadline`, and none after one timed out (the analyzer is busy). */
interface Budget { deadline: number; spent: boolean }

/** The job's result, or a timeout error at the budget's deadline – the job goes on (a copy made later is still cached). */
function within<T>(job: Promise<T>, budget: Budget): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { budget.spent = true; reject(new WorkforceError('timeout', BUSY)); }, Math.max(0, budget.deadline - Date.now()));
    job.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function visionInput(s: VisionServices, image: { path: string; mime: string }, budget: Budget): Promise<VisionItem> {
  const mime = visionMime(image.mime);
  const fileId = blobId(s, image.path);
  const facts = await factsOf(s, image.path, fileId, mime);
  const asIs: VisionItem = { type: 'image', path: image.path, mime: VISION_MIMES.has(mime) ? mime : image.mime };
  if (!facts || fitsAsIs(facts)) return asIs; // an unknown file goes as before: the engine says when it cannot read it
  let why = 'it is no stored file, so no copy can be made';
  if (fileId) {
    try {
      const hit = await cached(s, fileId);
      if (hit) return { type: 'image', ...hit };
      if (budget.spent || Date.now() >= budget.deadline) throw new WorkforceError('timeout', BUSY);
      const job = convert(s, { fileId, mime, read: () => readBounded(image.path) }).then(async (made) => ({ path: await store(s, fileId, made), mime: made.mime }));
      return { type: 'image', ...await within(job, budget) };
    } catch (error) {
      why = reason(error);
      s.log.info('an image goes without a converted copy', { fileId, mime, error: why });
    }
  }
  if (fitsAsIs(facts, VISION_LIMITS.fallbackPx)) return asIs;
  let name = path.basename(image.path);
  try { name = (fileId && s.files.get(fileId)?.name) || name; } catch { /* the path's name */ }
  return { type: 'text', text: unsentLine(name, why) };
}

/**
 * The image inputs of one turn (the delta's images, in order): each as it is, as its converted copy, or – when
 * neither works – a text line. One at a time: the media analyzer takes one job (and only a few waiting); the turn
 * waits at most `budgetMs` for all copies, then an image without one follows the rule for no copy.
 */
export async function visionInputs(s: VisionServices, images: ReadonlyArray<{ path: string; mime: string }>, budgetMs: number = VISION_LIMITS.turnMs): Promise<VisionItem[]> {
  const budget: Budget = { deadline: Date.now() + budgetMs, spent: false };
  const out: VisionItem[] = [];
  for (const image of images) out.push(await visionInput(s, image, budget));
  return out;
}
