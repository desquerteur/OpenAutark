// Chunked uploads (`files.uploadChunk`): recordings and large files arrive as ≤ 4 MB base64
// chunks per `uploadId`. Chunks are appended to a file under <temp>/uploads/<uploadId>/ (never
// held in RAM together), strictly in index order; the final chunk stores the bytes in the blob
// store and removes the temp data. Sessions expire 30 minutes after their last chunk.
// Owns: upload sessions, ordering, size caps, per-upload serialization, temp cleanup.
// Never: keeps whole uploads in memory, lets another client append to someone's upload, or
// runs a timer (expiry is checked lazily on the next upload call).

import { appendFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { WorkforceError } from '../../shared/errors.ts';
import { isId } from '../../shared/ids.ts';
import type { FileRef } from '../../shared/model/system.ts';
import type { Clock, FileStore, Logger } from '../contracts.ts';

export const CHUNK_MAX_BYTES = 4 * 1024 * 1024;
export const UPLOAD_MAX_BYTES = 300 * 1024 * 1024;
export const UPLOAD_TTL_MS = 30 * 60_000;
/** Final uploads up to this size go through FileStore.put; larger ones are streamed (putPath). */
const PUT_IN_MEMORY_MAX = 25 * 1024 * 1024;
const MAX_SESSIONS = 32;
const SWEEP_EVERY_MS = 10 * 60_000;
const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

export interface ChunkInput {
  uploadId: string;
  index: number;
  dataBase64: string;
  final: boolean;
  name: string;
  mime?: string;
  /** Who may continue this upload ('owner' or 'device:<id>'). */
  owner: string;
}

export interface ChunkUploadDeps {
  /** Paths.temp – sessions live in <temp>/uploads. */
  temp: string;
  files: FileStore;
  clock: Clock;
  log?: Logger;
  /** Size up to which the final upload is read into memory for put() (tests; default 25 MB). */
  inMemoryMax?: number;
}

interface Session {
  id: string;
  owner: string;
  name: string;
  mime?: string;
  dir: string;
  file: string;
  next: number;
  bytes: number;
  touchedAt: number;
  queue: Promise<unknown>;
}

/** Max base64 length of `bytes` decoded bytes (padding included). */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** Decodes standard or URL-safe base64 after checking the alphabet (Buffer ignores junk silently). */
export function decodeBase64(value: string, key: string): Buffer {
  if (!BASE64.test(value)) throw new WorkforceError('bad_request', `Invalid parameter "${key}": expected base64 data.`, { details: { param: key } });
  return Buffer.from(value, value.includes('-') || value.includes('_') ? 'base64url' : 'base64');
}

/** A file name safe for one path segment on every OS (used so putPath keeps the real name). */
export function safeFileName(name: string): string {
  const base = path.basename(String(name || 'file')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/^[. ]+|[. ]+$/g, '').trim();
  const cut = (base || 'file').slice(0, 180);
  return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(cut) ? `_${cut}` : cut;
}

export class ChunkUploads {
  private readonly deps: ChunkUploadDeps;
  private readonly sessions = new Map<string, Session>();
  private sweptAt = Number.NEGATIVE_INFINITY;

  constructor(deps: ChunkUploadDeps) {
    this.deps = deps;
  }

  private get root(): string {
    return path.join(this.deps.temp, 'uploads');
  }

  /** Accepts one chunk. Concurrent calls for the same upload run one after another. */
  chunk(input: ChunkInput): Promise<{ received: number; file?: FileRef }> {
    if (!isId(input.uploadId, 'up')) throw new WorkforceError('bad_request', 'Invalid parameter "uploadId": expected an upload id.', { details: { param: 'uploadId' } });
    if (input.dataBase64.length > base64Length(CHUNK_MAX_BYTES) + 4) {
      throw new WorkforceError('bad_request', 'Upload chunks must be at most 4 MB.', { details: { param: 'dataBase64' } });
    }
    const now = this.deps.clock.now();
    this.expire(now);
    let session = this.sessions.get(input.uploadId);
    if (session && session.owner !== input.owner) throw new WorkforceError('forbidden', 'This upload belongs to another device.');
    if (!session) {
      if (input.index !== 0) {
        throw new WorkforceError('not_found', 'This upload expired or never started. Start it again.', { details: { uploadId: input.uploadId, expected: 0 } });
      }
      if (this.sessions.size >= MAX_SESSIONS) throw new WorkforceError('rate_limited', 'Too many uploads at once. Try again shortly.', { retryAfterMs: 5000 });
      const dir = path.join(this.root, input.uploadId);
      session = {
        id: input.uploadId, owner: input.owner, name: input.name, mime: input.mime, dir, file: path.join(dir, safeFileName(input.name)),
        next: 0, bytes: 0, touchedAt: now, queue: Promise.resolve(),
      };
      this.sessions.set(session.id, session);
    }
    session.touchedAt = now;
    const current = session;
    const run = current.queue.then(() => this.apply(current, input));
    current.queue = run.catch(() => undefined);
    return run;
  }

  /** Number of open upload sessions (diagnostics/tests). */
  get open(): number {
    return this.sessions.size;
  }

  /** F-52 (people/uploads.ts): open, not expired sessions whose owner starts with `prefix` (per-person limits). */
  openOf(prefix: string): number {
    this.expire(this.deps.clock.now());
    let count = 0;
    for (const session of this.sessions.values()) if (session.owner.startsWith(prefix)) count++;
    return count;
  }

  private async apply(session: Session, input: ChunkInput): Promise<{ received: number; file?: FileRef }> {
    if (this.sessions.get(session.id) !== session) {
      throw new WorkforceError('not_found', 'This upload expired or never started. Start it again.', { details: { uploadId: session.id, expected: 0 } });
    }
    if (input.index !== session.next) {
      throw new WorkforceError('conflict', `Expected chunk ${session.next}.`, { details: { uploadId: session.id, expected: session.next } });
    }
    const bytes = decodeBase64(input.dataBase64, 'dataBase64');
    if (bytes.length > CHUNK_MAX_BYTES) throw new WorkforceError('bad_request', 'Upload chunks must be at most 4 MB.', { details: { param: 'dataBase64' } });
    if (session.bytes + bytes.length > UPLOAD_MAX_BYTES) {
      await this.discard(session);
      throw new WorkforceError('bad_request', 'Uploads can be at most 300 MB.');
    }
    if (session.next === 0) await mkdir(session.dir, { recursive: true });
    if (bytes.length) await appendFile(session.file, bytes, { mode: 0o600 });
    session.next += 1;
    session.bytes += bytes.length;
    session.touchedAt = this.deps.clock.now();
    if (!input.final) return { received: session.bytes };

    try {
      if (session.bytes === 0) throw new WorkforceError('bad_request', 'The file is empty.');
      // Both paths keep the client's mime hint; the streamed one's temp file carries the real name.
      const file = session.bytes <= (this.deps.inMemoryMax ?? PUT_IN_MEMORY_MAX)
        ? await this.deps.files.put(new Uint8Array(await readFile(session.file)), session.name, session.mime)
        : await this.deps.files.putPath(session.file, session.mime);
      return { received: session.bytes, file };
    } finally {
      await this.discard(session);
    }
  }

  private async discard(session: Session): Promise<void> {
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    await rm(session.dir, { recursive: true, force: true }).catch((error: unknown) => {
      this.deps.log?.warn('upload temp cleanup failed', { uploadId: session.id, error: String(error) });
    });
  }

  /** Drops expired sessions; now and then also removes leftovers of earlier runs from disk. */
  private expire(now: number): void {
    for (const session of [...this.sessions.values()]) {
      if (now - session.touchedAt > UPLOAD_TTL_MS) {
        // Wait for chunks in flight before deleting their file.
        void session.queue.then(() => this.discard(session));
        this.sessions.delete(session.id);
      }
    }
    if (now - this.sweptAt < SWEEP_EVERY_MS) return;
    this.sweptAt = now;
    void this.sweepDisk(now);
  }

  private async sweepDisk(now: number): Promise<void> {
    let entries: string[];
    try { entries = await readdir(this.root); } catch { return; }
    for (const entry of entries) {
      if (this.sessions.has(entry)) continue;
      const dir = path.join(this.root, entry);
      try {
        const info = await stat(dir);
        if (now - info.mtimeMs > UPLOAD_TTL_MS && !this.sessions.has(entry)) await rm(dir, { recursive: true, force: true });
      } catch { /* vanished meanwhile */ }
    }
  }
}
