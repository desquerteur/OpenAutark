// B-047 D14: downloads one local speech model into <data>/models/speech/<id> (store.ts) – the catalog's
// HTTPS address only (GitHub release assets; redirects to GitHub's download host are followed, a plain
// http hop is refused), streamed into .<id>.part while its SHA-256 is computed, resumed with a Range
// request when an earlier download stopped (the bytes already there are hashed first; a server that
// answers 200 instead of 206 starts it over), never larger than the catalog says, checked against the
// catalog's SHA-256 (a mismatch deletes the part: the next try starts clean), then a tar.bz2 is unpacked
// by the system's tar (Windows 10+ ships bsdtar in System32; it refuses '..' and absolute paths) into
// .<id>.unpack, the model's files are checked, the folder is moved in place and the manifest is written
// last. A download that sends nothing for IDLE_MS fails (a stalled connection never hangs forever). The
// disk must hold the rest of the download plus the unpacked files. One install per model and data folder
// at a time (installModel joins a running one).
// Owns: the transfer, the hash, the unpack and the install order. Never: downloads anything outside the
// catalog, runs anything from the archive, or reports a server's raw answer.

import { createHash, type Hash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LocalSpeechModel } from '../../../shared/model/local-speech-models.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { isInstalled, MANIFEST, modelDir, partFile, speechRoot, unpackDir } from './store.ts';

export const IDLE_MS = 60_000;
export const PROGRESS_MS = 500;
const UNPACK_TIMEOUT_MS = 15 * 60_000;
const DISK_MARGIN = 50_000_000;

export type DownloadFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface InstallDeps {
  dataDir: string;
  fetch?: DownloadFetch;
  /** Bytes so far / in all while it downloads; 'unpacking' once the archive is complete. */
  progress?: (state: 'downloading' | 'unpacking', done: number, total: number) => void;
  /** Unpacks a tar.bz2 into a folder (default: the system's tar). */
  unpack?: (archive: string, into: string) => Promise<void>;
  /** Free bytes on the disk of `dir` (default: statfs; undefined = unknown, not checked). */
  freeDisk?: (dir: string) => Promise<number | undefined>;
  idleMs?: number;
  now?: () => number;
}

const fail = (message: string) => new WorkforceError('unavailable', message);

/** The system tar: %SystemRoot%\System32\tar.exe on Windows (never a tar of some other PATH entry), else tar. */
export function systemTar(): string {
  return process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

const tarUnpack = (archive: string, into: string) => new Promise<void>((resolve, reject) => {
  execFile(systemTar(), ['-xjf', archive, '-C', into], { windowsHide: true, timeout: UNPACK_TIMEOUT_MS, maxBuffer: 1 << 20 }, (error) => (error ? reject(error) : resolve()));
});

async function diskFree(dir: string): Promise<number | undefined> {
  try { const info = await statfs(dir); return Number(info.bavail) * Number(info.bsize); } catch { return undefined; }
}

async function sizeOf(file: string): Promise<number> {
  try { return (await stat(file)).size; } catch { return 0; }
}

async function hashInto(file: string, hash: Hash): Promise<void> {
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
}

const running = new Map<string, Promise<void>>(); // part file → its install (any caller: voice pulls, the sound model, the auto download)

/**
 * Downloads, verifies and unpacks `model` (nothing when it is installed already) – any catalog entry with a
 * download: speech to text, a voice, the VAD or (B-058) the audio tagger. A second call for the same model
 * and data folder joins the running one (two writers of one .part file break each other's checksum); only
 * the first caller gets progress.
 */
export function installModel(model: LocalSpeechModel, deps: InstallDeps): Promise<void> {
  const key = partFile(deps.dataDir, model);
  const known = running.get(key);
  if (known) return known;
  const job = installNow(model, deps).finally(() => running.delete(key));
  running.set(key, job);
  return job;
}

async function installNow(model: LocalSpeechModel, deps: InstallDeps): Promise<void> {
  const root = speechRoot(deps.dataDir);
  await mkdir(root, { recursive: true });
  if (isInstalled(deps.dataDir, model)) return;
  const part = partFile(deps.dataDir, model);
  const total = model.download.bytes;
  let have = await sizeOf(part);
  if (have > total) { await rm(part, { force: true }); have = 0; }
  const free = await (deps.freeDisk ?? diskFree)(root);
  const needed = total - have + model.sizeMb * 1_000_000 + DISK_MARGIN;
  if (free !== undefined && free < needed) throw fail(`Not enough disk space for ${model.label}: it needs about ${Math.ceil(needed / 1_000_000)} MB, ${Math.floor(free / 1_000_000)} MB are free.`);

  let hash = createHash('sha256');
  if (have > 0) await hashInto(part, hash);
  if (have < total) hash = await fetchInto(model, part, have, hash, deps);
  if (hash.digest('hex') !== model.download.sha256) {
    await rm(part, { force: true });
    throw fail(`The download of ${model.label} was damaged (its checksum does not match). Try again.`);
  }
  deps.progress?.('unpacking', total, total);
  const dir = modelDir(deps.dataDir, model);
  if (model.download.format === 'file') {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await rename(part, path.join(dir, model.download.file ?? model.files[0]));
  } else {
    const into = unpackDir(deps.dataDir, model);
    await rm(into, { recursive: true, force: true });
    await mkdir(into, { recursive: true });
    try {
      await (deps.unpack ?? tarUnpack)(part, into);
      const source = path.join(into, model.download.folder ?? '');
      for (const file of model.files) if (!(await sizeOf(path.join(source, file)))) throw fail(`The download of ${model.label} is missing ${file}.`);
      await rm(dir, { recursive: true, force: true });
      await rename(source, dir);
    } catch (error) {
      await rm(into, { recursive: true, force: true });
      if (error instanceof WorkforceError) { await rm(part, { force: true }); throw error; }
      throw fail(`${model.label} could not be unpacked on this PC.`);
    }
    await rm(into, { recursive: true, force: true });
    await rm(part, { force: true });
  }
  await writeFile(path.join(dir, MANIFEST), JSON.stringify({ id: model.id, sha256: model.download.sha256, installedAt: (deps.now ?? Date.now)() }));
}

/** Streams the rest of the archive into `part` (Range from `have`); returns the hash over the whole file. */
async function fetchInto(model: LocalSpeechModel, part: string, have: number, hash: Hash, deps: InstallDeps): Promise<Hash> {
  const total = model.download.bytes;
  const controller = new AbortController();
  const idleMs = deps.idleMs ?? IDLE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alive = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), idleMs);
    (timer as { unref?: () => void }).unref?.();
  };
  const now = deps.now ?? Date.now;
  alive();
  let output: ReturnType<typeof createWriteStream> | undefined;
  let oversize = false; // the server's file is not the catalog's: the part goes, the next try starts clean
  try {
    const headers: Record<string, string> = { Accept: 'application/octet-stream' };
    if (have > 0) headers.Range = `bytes=${have}-`;
    let response = await (deps.fetch ?? fetch)(model.download.url, { headers, redirect: 'follow', signal: controller.signal });
    if (response.status === 416 && have > 0) { // the part is not what the server has: start over
      await response.body?.cancel().catch(() => undefined);
      response = await (deps.fetch ?? fetch)(model.download.url, { headers: { Accept: 'application/octet-stream' }, redirect: 'follow', signal: controller.signal });
      have = 0;
    }
    if (response.url && !response.url.startsWith('https://')) { await response.body?.cancel().catch(() => undefined); throw fail(`The download of ${model.label} was redirected away from HTTPS.`); }
    const resumed = have > 0 && response.status === 206;
    if (!response.ok || !response.body || (response.status !== 200 && !resumed)) {
      await response.body?.cancel().catch(() => undefined);
      throw fail(`The download server answered ${response.status} for ${model.label}. Try again later.`);
    }
    if (!resumed) { have = 0; hash = createHash('sha256'); }
    output = createWriteStream(part, { flags: resumed ? 'a' : 'w' });
    const sink = output;
    const opened = new Promise<void>((resolve, reject) => { sink.once('error', reject); sink.once('open', () => resolve()); });
    await opened;
    let done = have;
    let shown = 0;
    deps.progress?.('downloading', done, total);
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      alive();
      done += chunk.byteLength;
      if (done > total) { oversize = true; throw fail(`The download of ${model.label} is larger than expected.`); }
      hash.update(chunk);
      if (sink.errored) throw sink.errored; // review fix: a failed write (disk full, locked file) never drains – waiting for it hung the pull for good
      if (!sink.write(chunk)) await once(sink, 'drain'); // rejects on the stream's 'error'
      if (now() - shown >= PROGRESS_MS) { shown = now(); deps.progress?.('downloading', done, total); }
    }
    await new Promise<void>((resolve, reject) => sink.end((error?: Error | null) => (error ? reject(error) : resolve())));
    output = undefined;
    if (done !== total) throw fail(`The download of ${model.label} stopped before it finished. Try again – it continues where it stopped.`);
    deps.progress?.('downloading', done, total);
    return hash;
  } catch (error) {
    if (error instanceof WorkforceError) throw error;
    throw fail(controller.signal.aborted
      ? `The download of ${model.label} stalled. Try again – it continues where it stopped.`
      : `Could not download ${model.label}. Check the connection and try again – it continues where it stopped.`);
  } finally {
    if (timer) clearTimeout(timer);
    if (output) await new Promise<void>((resolve) => output!.end(() => resolve()));
    if (oversize) await rm(part, { force: true });
  }
}
