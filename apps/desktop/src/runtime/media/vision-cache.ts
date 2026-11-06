// B-058 G10 – the cache of converted image copies (media/vision-image.ts makes them): <temp>/vision/<blob id>.jpg|png,
// one per stored image (a blob id names its content, so a copy never goes stale). A copy is written atomically (a
// part file, then a rename); one that is there already stays – two turns with the same image store it at once, and on
// Windows a copy an engine has open cannot be replaced. After each write the newest VISION_CACHE.files copies within
// VISION_CACHE.bytes stay, and part files a crash left go.
// Owns: the cache folder, its names and its bounds. Never: reads or changes a stored blob, or fails over a copy it
// cannot delete (one an engine has open goes next time).

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NormalizedImage } from '../../shared/api/host-bridge.ts';
import type { RuntimeServices } from '../contracts.ts';

export const VISION_CACHE = {
  files: 200,
  bytes: 256 * 1024 * 1024,
  /** A part file this old was left by a crash. */
  stalePartMs: 10 * 60_000,
} as const;

export type CacheServices = Pick<RuntimeServices, 'paths' | 'log'>;

const COPY_NAME = /^[a-f0-9]{64}\.(jpg|png)$/;
const EXTENSIONS: ReadonlyArray<[string, NormalizedImage['mime']]> = [['jpg', 'image/jpeg'], ['png', 'image/png']];

export const visionCacheDir = (s: Pick<RuntimeServices, 'paths'>) => path.join(s.paths.temp, 'vision');
const isFile = async (file: string) => (await stat(file).catch(() => undefined))?.isFile() === true;

/** The cached copy of a stored image, if any. */
export async function cachedCopy(s: Pick<RuntimeServices, 'paths'>, fileId: string): Promise<{ path: string; mime: string } | undefined> {
  for (const [extension, mime] of EXTENSIONS) {
    const file = path.join(visionCacheDir(s), `${fileId}.${extension}`);
    if (await isFile(file)) return { path: file, mime };
  }
  return undefined;
}

/** Keeps the newest copies within VISION_CACHE.files and .bytes; drops part files a crash left. */
async function prune(dir: string): Promise<void> {
  const now = Date.now();
  const entries = await Promise.all((await readdir(dir)).map(async (name) => {
    const info = await stat(path.join(dir, name)).catch(() => undefined);
    return { name, at: info?.mtimeMs ?? 0, bytes: info?.size ?? 0 };
  }));
  let bytes = 0;
  const copies = entries.filter((entry) => COPY_NAME.test(entry.name)).sort((a, b) => b.at - a.at); // newest first
  const old = copies.filter((entry, index) => (bytes += entry.bytes) > VISION_CACHE.bytes || index >= VISION_CACHE.files);
  const stale = entries.filter((entry) => entry.name.endsWith('.part') && now - entry.at > VISION_CACHE.stalePartMs);
  for (const entry of [...old, ...stale]) await rm(path.join(dir, entry.name), { force: true }).catch(() => undefined); // open in an engine: next time
}

/** Stores a copy (see the header) and returns its path. */
export async function storeCopy(s: CacheServices, fileId: string, image: NormalizedImage): Promise<string> {
  const dir = visionCacheDir(s);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${fileId}.${image.mime === 'image/png' ? 'png' : 'jpg'}`);
  if (await isFile(file)) return file;
  const part = `${file}.${randomUUID()}.part`;
  await writeFile(part, image.data);
  try { await rename(part, file); } catch (error) {
    await rm(part, { force: true }).catch(() => undefined);
    if (!await isFile(file)) throw error;
  }
  await prune(dir).catch((error) => s.log.warn('pruning the vision cache failed', { error: String(error) }));
  return file;
}
