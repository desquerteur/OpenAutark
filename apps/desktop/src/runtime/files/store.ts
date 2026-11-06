// FileStore: content-addressed blobs at <blobs>/ab/cd/<sha256> plus metadata rows in `files`.
// Owns: hashing, atomic blob writes (temp + rename, mode 0600), mime detection, image size,
// lazy text extraction (text files, PDFs, Office documents – office.ts) cached in files.text_preview; MM6: removing one file
// (blob, files row, media row and its search entry) when asked – never while the same bytes
// are being stored, and a put of those bytes waits for a running removal – plus the blob
// clean-up of this store (files/cleanup.ts: queue, batch, start-up reconcile). A read of a file whose row came from
// another of the person's PCs fetches its bytes first (deps.missing: devices/sync/blobs.ts needBlob, compose/services.ts).
// Never: decides on its own that a file may go (the clean-up asks files/references.ts, the
// person confirms media.delete), trusts file names for binary types, or parses a PDF before
// someone asks for its text.

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Clock, FileStore, Logger } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { FileRef } from '../../shared/model/system.ts';
import { MediaRepo } from '../media/repo.ts';
import { FileRepo } from '../store/files.ts';
import { ROOT_SETTINGS } from '../root/layout.ts';
import { BlobCleanup, graceFromEnv, type CleanupTimers, type Reclaimer } from './cleanup.ts';
import { detectMime, imageSize, isTextMime } from './mime.ts';
import { extractPdfText, PDF_LIMITS, type PdfTextExtractor } from './pdf.ts';
import { OFFICE_LIMITS, officeKind, officeText } from './office.ts';

export interface FileStoreDeps {
  db: Db;
  blobs: string; // Paths.blobs
  clock: Clock;
  log: Logger;
  pdfText?: PdfTextExtractor; // injectable for tests
  maxPutBytes?: number; // in-memory put() limit, default 100 MiB
  maxPathBytes?: number; // streamed putPath() limit, default 4 GiB
  /** MM6 clean-up: files younger than this stay (default 60 s; tests shorten it). */
  graceMs?: number;
  /** MM6 clean-up: the retry timer (tests inject fakes). */
  timers?: CleanupTimers;
  /** <data>/settings.json – a setting naming a file keeps it (default: beside the blobs folder, <data>/blobs). */
  settingsFile?: string;
  /** A file whose row is here but whose bytes are not (they live on another of the person's PCs): fetches them, true when they are here now. */
  missing?: (id: string) => Promise<boolean>;
}

const SHA256 = /^[a-f0-9]{64}$/;
const TEXT_CACHE_CHARS = 100_000;
const TEXT_READ_BYTES = 512 * 1024;
const SNIFF_BYTES = 64 * 1024;
const STORED_KEEP = 2000; // remembered "stored at" entries before old ones are dropped

function cleanFileName(name: string): string {
  const base = path.basename(String(name || 'file')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  return (base || 'file').slice(0, 200);
}

export class Blobs implements FileStore, Reclaimer {
  /** The blob clean-up of this store (MM6). */
  readonly cleanup: BlobCleanup;
  private readonly deps: FileStoreDeps;
  private readonly repo: FileRepo;
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly writing = new Map<string, number>(); // id → puts storing these bytes right now
  private readonly removing = new Map<string, Promise<void>>(); // id → running removal
  private readonly stored = new Map<string, number>(); // id → last put/putPath in this process

  constructor(deps: FileStoreDeps) {
    this.deps = deps;
    this.repo = new FileRepo(deps.db);
    this.cleanup = new BlobCleanup({
      db: deps.db, clock: deps.clock, log: deps.log, tempDir: path.join(deps.blobs, 'tmp'),
      graceMs: deps.graceMs ?? graceFromEnv(), timers: deps.timers, settingsFile: deps.settingsFile ?? path.join(path.dirname(deps.blobs), ROOT_SETTINGS),
      remove: (id) => this.remove(id), storedAt: (id) => this.stored.get(id),
    });
  }

  path(id: string): string {
    if (!SHA256.test(id)) throw new WorkforceError('bad_request', 'Invalid file id.');
    return path.join(this.deps.blobs, id.slice(0, 2), id.slice(2, 4), id);
  }

  get(id: string): FileRef | undefined {
    return SHA256.test(id) ? this.repo.get(id) : undefined;
  }

  async put(data: Uint8Array, name: string, mime?: string): Promise<FileRef> {
    const limit = this.deps.maxPutBytes ?? 100 * 1024 * 1024;
    if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new WorkforceError('bad_request', 'The file is empty.');
    if (data.byteLength > limit) throw new WorkforceError('bad_request', `Choose a file smaller than ${Math.floor(limit / 1024 / 1024)} MB.`);
    const id = createHash('sha256').update(data).digest('hex');
    const target = this.path(id);
    this.hold(id);
    try {
      await this.removing.get(id); // the same bytes are being removed: store them again afterwards
      if (!(await exists(target))) {
        const temp = await this.tempPath();
        try {
          const handle = await open(temp, 'wx', 0o600);
          try { await handle.writeFile(data); } finally { await handle.close(); }
          await this.commit(temp, target);
        } finally {
          await rm(temp, { force: true });
        }
      }
      return this.register(id, cleanFileName(name), data.byteLength, data.subarray(0, SNIFF_BYTES), mime);
    } finally {
      this.release(id);
    }
  }

  async putPath(source: string, mime?: string): Promise<FileRef> {
    const limit = this.deps.maxPathBytes ?? 4 * 1024 * 1024 * 1024;
    let info;
    try { info = await stat(source); } catch { throw new WorkforceError('not_found', 'The file could not be found.'); }
    if (!info.isFile()) throw new WorkforceError('bad_request', 'Choose a file, not a folder.');
    if (info.size === 0) throw new WorkforceError('bad_request', 'The file is empty.');
    if (info.size > limit) throw new WorkforceError('bad_request', 'The file is too large.');

    // Stream: hash and copy in one pass, never holding the whole file in memory.
    const temp = await this.tempPath();
    const hash = createHash('sha256');
    const head: Buffer[] = [];
    let headBytes = 0;
    let size = 0;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try {
        for await (const chunk of createReadStream(source, { highWaterMark: 1024 * 1024 }) as AsyncIterable<Buffer>) {
          hash.update(chunk);
          size += chunk.length;
          if (headBytes < SNIFF_BYTES) { head.push(chunk.subarray(0, SNIFF_BYTES - headBytes)); headBytes += Math.min(chunk.length, SNIFF_BYTES - headBytes); }
          await handle.write(chunk);
        }
      } finally { await handle.close(); }
      const id = hash.digest('hex');
      const target = this.path(id);
      this.hold(id);
      try {
        await this.removing.get(id);
        if (!(await exists(target))) await this.commit(temp, target);
        return this.register(id, cleanFileName(path.basename(source)), size, Buffer.concat(head), mime);
      } finally {
        this.release(id);
      }
    } finally {
      await rm(temp, { force: true });
    }
  }

  async read(id: string): Promise<Uint8Array> {
    if (!this.get(id)) throw new WorkforceError('not_found', 'This file does not exist.');
    await this.fetched(id);
    try { return new Uint8Array(await readFile(this.path(id))); } catch { throw new WorkforceError('not_found', 'The stored file is missing.'); }
  }

  async text(id: string, maxChars = TEXT_CACHE_CHARS): Promise<string | undefined> {
    const file = this.get(id);
    if (!file) return undefined;
    const cached = this.repo.cachedText(id);
    if (cached !== undefined) return cached ? cached.slice(0, maxChars) : undefined;
    if (!isTextMime(file.mime) && file.mime !== 'application/pdf' && !officeKind(file.mime)) return undefined;

    // One extraction per file at a time, however many callers ask concurrently.
    let pending = this.inflight.get(id);
    if (!pending) {
      pending = this.extract(file).finally(() => this.inflight.delete(id));
      this.inflight.set(id, pending);
    }
    const text = await pending;
    return text ? text.slice(0, maxChars) : undefined;
  }

  // ------------------------------------------------------------------ MM6: removal and clean-up

  /**
   * Removes one file now: the blob, then (in one transaction) its media row with the search
   * entry and the files row – the cached text (e.g. a transcript) goes with it. False while
   * the same bytes are being stored or removed, or when the blob cannot be deleted (rows stay).
   * Callers check the uses first (files/references.ts).
   */
  async remove(id: string): Promise<boolean> {
    if (!SHA256.test(id) || this.writing.has(id) || this.removing.has(id)) return false;
    let finish: () => void = () => undefined;
    this.removing.set(id, new Promise<void>((resolve) => { finish = resolve; }));
    try {
      await rm(this.path(id), { force: true });
      if (this.writing.has(id)) return false; // a put of these bytes waits for us and writes the blob again; its row stays
      this.deps.db.tx(() => {
        new MediaRepo(this.deps.db).remove(id);
        this.repo.remove(id);
      });
      this.stored.delete(id);
      return true;
    } catch (error) {
      this.deps.log.warn('file not removed', { id, error: String(error) });
      return false;
    } finally {
      this.removing.delete(id);
      finish();
    }
  }

  /** Queues files a deletion or a transcribed dictation take may have freed, due now or at `notBefore` (files/cleanup.ts decides). */
  reclaim(fileIds: Iterable<string>, options: { notBefore?: number } = {}): void {
    try { this.cleanup.enqueue(fileIds, options.notBefore); } catch (error) { this.deps.log.warn('file clean-up not queued', { error: String(error) }); }
  }

  /** Start-up: the bounded orphan reconcile of the clean-up. */
  reconcileOrphans(): void {
    this.cleanup.reconcile();
  }

  // ------------------------------------------------------------------ internals

  /** The bytes of a file whose row is here: fetched through `missing` when they are not (a failed fetch leaves the read to fail). */
  private async fetched(id: string): Promise<void> {
    if (this.deps.missing && !(await exists(this.path(id)))) await this.deps.missing(id).catch(() => false);
  }

  private async extract(file: FileRef): Promise<string> {
    let text: string;
    if (file.mime === 'application/pdf') {
      const started = this.deps.clock.now();
      text = (await (this.deps.pdfText ?? extractPdfText)(await this.read(file.id))).slice(0, PDF_LIMITS.chars);
      this.deps.log.debug('pdf text extracted', { id: file.id, chars: text.length, ms: this.deps.clock.now() - started });
    } else if (officeKind(file.mime)) {
      text = file.size > OFFICE_LIMITS.bytes ? '' : await officeText(await this.read(file.id), officeKind(file.mime)!);
    } else {
      await this.fetched(file.id);
      const handle = await open(this.path(file.id), 'r');
      try {
        const buffer = Buffer.alloc(Math.min(file.size, TEXT_READ_BYTES));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        text = new TextDecoder('utf-8').decode(buffer.subarray(0, bytesRead)).replace(/�+$/u, '');
      } finally { await handle.close(); }
    }
    text = text.slice(0, TEXT_CACHE_CHARS);
    this.repo.setText(file.id, text.trim() ? text : '');
    return text.trim() ? text : '';
  }

  private register(id: string, name: string, size: number, head: Uint8Array, hint?: string): FileRef {
    const mime = detectMime(head, name, hint);
    const dims = mime.startsWith('image/') ? imageSize(head, mime) : undefined;
    const ref = this.repo.insert({ id, name, mime, size, createdAt: this.deps.clock.now(), ...(dims ?? {}) });
    this.noteStored(id);
    return ref;
  }

  /** Same bytes stored again count as young for the clean-up (the files row keeps its first time). */
  private noteStored(id: string): void {
    this.stored.delete(id);
    this.stored.set(id, this.deps.clock.now());
    if (this.stored.size > STORED_KEEP) {
      for (const key of this.stored.keys()) { this.stored.delete(key); if (this.stored.size <= STORED_KEEP / 2) break; }
    }
  }

  private hold(id: string): void {
    this.writing.set(id, (this.writing.get(id) ?? 0) + 1);
  }

  private release(id: string): void {
    const left = (this.writing.get(id) ?? 1) - 1;
    if (left > 0) this.writing.set(id, left); else this.writing.delete(id);
  }

  private async tempPath(): Promise<string> {
    const dir = path.join(this.deps.blobs, 'tmp');
    await mkdir(dir, { recursive: true });
    return path.join(dir, `${randomUUID()}.part`);
  }

  private async commit(temp: string, target: string): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await rename(temp, target);
    } catch (error) {
      // A concurrent writer may have stored the same content first – identical bytes, fine.
      if (!(await exists(target))) throw error;
    }
  }
}

async function exists(file: string): Promise<boolean> {
  try { await stat(file); return true; } catch { return false; }
}
