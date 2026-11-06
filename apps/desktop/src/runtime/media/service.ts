// Media library service: keeps one `media` row (+ media_fts) per stored file, links it to the
// chat a message first attaches or shows it in (attachments and fileIds in its ```ui blocks,
// e.g. agent outputs stored by media/outputs.ts), probes header facts in the background (image
// size, duration, video size, PDF pages – one file at a time, event-driven), lists/searches media
// by name, description and tags and stores human/agent descriptions, emitting media.upserted for
// every visible change. Descriptions are never generated automatically: agents describe media
// when they look at them (the media.describe tool asks them to).
// MM6: what still uses a file and deleting it on the person's request (media/delete.ts).
// B-078: a probe whose blob is not here yet pulls it from a linked PC and tries again a few times, further apart
// (dictation.ts RETRY_MS) until the blob exists; a person's recording becomes the message's text (dictation.ts).
// Owns: the hook → row step, message → chat links and the probe queue. Never: changes FileStore
// behaviour or blob bytes, throws out of onFileStored (it runs inside every upload), or blocks an
// upload on a probe.

import type { Message } from '../../shared/model/chat.ts';
import type { MediaFilter, MediaInfo, MediaPatch } from '../../shared/model/media.ts';
import type { MediaUses } from '../../shared/model/media-uses.ts';
import type { FileRef } from '../../shared/model/system.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { MediaApi } from '../rpc/extras.ts';
import { FileRepo } from '../store/files.ts';
import type { ToolDef } from '../tools/types.ts';
import { deleteFile, usesOf } from './delete.ts';
import { MediaLibrary } from './library.ts';
import { blockFileIds } from './outputs.ts';
import { countPdfPages, type PdfPageCounter } from './pdf-pages.ts';
import { kindOf, needsProbe, probeFile } from './probe.ts';
import { MediaRepo } from './repo.ts';
import { blobHere, Dictation, RETRY_MS } from './dictation.ts';

const FILE_ID = /^[a-f0-9]{64}$/;

// MM6 additions to the RPC side of the library (rpc/extras.ts MediaApi; handlers/media.ts).
declare module '../rpc/extras.ts' {
  interface MediaApi {
    /** What still uses a stored file (media.uses). */
    uses(fileId: string): MediaUses;
    /** Deletes the file and the confirmed messages that show it; 'conflict' while anything else uses it (media.delete). */
    delete(fileId: string, options?: { messageIds?: string[] }): Promise<void>;
  }
}

export interface MediaServiceDeps {
  /** Late-bound services; db, bus, clock, log, paths and host are usable already in the constructor. */
  services: () => RuntimeServices;
  /** PDF page counter (default: pdf.js, imported on the first PDF). */
  pdfPages?: PdfPageCounter;
  /** Timer for the waits while a blob is missing (tests pass their own; default an unref'd setTimeout). */
  later?: (fn: () => void, ms: number) => void;
}

export class MediaService implements MediaApi {
  private readonly deps: MediaServiceDeps;
  private readonly library: MediaLibrary;
  private readonly repo: MediaRepo;
  private readonly queue = new Set<string>(); // file ids waiting for their probe
  private readonly waits = new Map<string, number>(); // file id → tries while its blob was missing
  private running?: Promise<void>;
  /** B-078: a person's recording becomes the message's text (media/dictation.ts). */
  readonly dictation: Dictation;

  constructor(deps: MediaServiceDeps) {
    this.deps = deps;
    const s = deps.services();
    // Secrets are bound later by the composition root; read them through the getter.
    this.library = new MediaLibrary({ db: s.db, bus: s.bus, clock: s.clock, get secrets() { return deps.services().secrets; } });
    this.repo = new MediaRepo(s.db);
    s.bus.on('message.created', (message) => this.linkMessage(message));
    s.bus.on('message.updated', (message) => this.linkMessage(message));
    this.dictation = new Dictation({ services: deps.services, ...(deps.later ? { later: deps.later } : {}) });
  }

  /**
   * Called by the FileStore hook (media/hook.ts) after every successful put/putPath, also for
   * content that was already stored (same sha256) – idempotent upsert. Returns at once; the
   * probe runs later.
   */
  onFileStored(file: FileRef, ctx?: { conversationId?: string }): void {
    try {
      this.record(file, ctx?.conversationId);
    } catch (error) {
      this.safeLog('media row not recorded', { id: file.id, error: String(error) });
    }
  }

  list(filter: MediaFilter = {}): MediaInfo[] {
    return this.library.list(filter);
  }

  describe(fileId: string, patch: MediaPatch, by: string): MediaInfo {
    return this.library.describe(fileId, patch, by);
  }

  get(fileId: string): MediaInfo | undefined {
    return this.library.get(fileId);
  }

  uses(fileId: string): MediaUses {
    return usesOf(this.deps.services(), fileId);
  }

  async delete(fileId: string, options: { messageIds?: string[] } = {}): Promise<void> {
    this.queue.delete(fileId); // no probe for a file that is going
    await deleteFile(this.deps.services(), fileId, options.messageIds);
  }

  /** Agent tools are built-in (tools/builtin/media.ts) and work on MediaLibrary directly. */
  tools(): ToolDef[] {
    return [];
  }

  /** Resolves once every queued probe has finished (tests, orderly shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  // ------------------------------------------------------------------ internals

  private record(file: FileRef, conversationId: string | undefined): void {
    const now = this.deps.services().clock.now();
    const created = this.repo.insert({
      fileId: file.id, name: file.name, mime: file.mime, kind: kindOf(file.mime), conversationId,
      width: file.width, height: file.height, durationMs: file.durationMs, now,
    });
    const linked = !created && conversationId ? this.repo.link(file.id, conversationId, now) : false;
    const info = this.repo.get(file.id);
    if (!info) return;
    if (created || linked) this.library.emit(info);
    if (needsProbe(info)) this.enqueue(file.id);
  }

  /** Attachments and block files of a message belong to its chat unless an earlier chat claimed them. */
  private linkMessage(message: Message): void {
    try {
      const ids = new Set((message.attachments ?? []).map((attachment) => attachment.fileId));
      if (message.state === 'final' && message.kind === 'text') for (const id of blockFileIds(message.body)) ids.add(id);
      if (!ids.size) return;
      const s = this.deps.services();
      for (const fileId of ids) {
        if (!FILE_ID.test(fileId)) continue;
        if (!this.repo.get(fileId)) {
          // Stored before the library existed (or imported without the hook): record it now.
          const file = new FileRepo(s.db).get(fileId);
          if (file) this.record(file, message.conversationId);
          continue;
        }
        if (!this.repo.link(fileId, message.conversationId, s.clock.now())) continue;
        const info = this.repo.get(fileId);
        if (info) this.library.emit(info);
      }
    } catch (error) {
      this.safeLog('media link failed', { messageId: message.id, error: String(error) });
    }
  }

  private enqueue(fileId: string): void {
    this.queue.add(fileId);
    this.running ??= this.drain();
  }

  /** One probe at a time; `running` is cleared in the same tick the queue is seen empty. */
  private async drain(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve)); // let the upload finish first
    for (;;) {
      const next = this.queue.values().next();
      if (next.done) { this.running = undefined; return; }
      this.queue.delete(next.value);
      try {
        await this.probe(next.value);
      } catch (error) {
        this.safeLog('media probe failed', { id: next.value, error: String(error) });
      }
    }
  }

  /** Header facts (size, duration, pages), stored with one event when something visible changed. */
  private async probe(fileId: string): Promise<void> {
    const s = this.deps.services();
    const info = this.repo.get(fileId);
    if (!info || !s.files || !needsProbe(info)) return;
    if (!(await blobHere(s, fileId))) { this.waitForBlob(fileId); return; }
    this.waits.delete(fileId);
    const facts = await probeFile({ path: s.files.path(fileId), mime: info.mime, size: info.size ?? 0 }, { pdfPages: this.deps.pdfPages ?? countPdfPages });
    if (!this.repo.setFacts(fileId, facts, s.clock.now())) return;
    const next = this.repo.get(fileId);
    if (next) this.library.emit(next);
  }

  /** A blob not here yet (stored on another PC): probed again later, further apart each time, a few times. */
  private waitForBlob(fileId: string): void {
    const tries = this.waits.get(fileId) ?? 0;
    if (tries >= RETRY_MS.length) { this.waits.delete(fileId); return; }
    this.waits.set(fileId, tries + 1);
    const later = this.deps.later ?? ((fn: () => void, ms: number) => { const timer = setTimeout(fn, ms); (timer as { unref?: () => void }).unref?.(); });
    later(() => this.enqueue(fileId), RETRY_MS[tries]);
  }

  private safeLog(message: string, data: Record<string, unknown>): void {
    try { this.deps.services().log.warn(message, data); } catch { /* never throw from the hook */ }
  }
}
