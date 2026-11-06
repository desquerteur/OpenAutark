// What keeps the vectors in step with the memory tree: every write and removal the store tells it, every direct edit the data
// folder watcher reports (the store's own writes never come here), and what is not embedded yet – moved rows, edits while the
// app was closed, a restored tree, a model connected later – once in the background. A model that fails is not called again at
// once: the tree is tried again later. Only entries are embedded: no _folder.md, nothing hidden. The same events keep the record
// of which stored files the tree names (memory-blobs.ts). A folder's event is walked only when the folder is new here (it came or was
// renamed): Windows also reports a folder when a file in it is written, and that file reports itself; a walk of the tree for it would scale with the tree at each write.
// Owns: when the vectors and that record hear of a file and that background pass. Never: writes an entry, or stops a memory write.

import { existsSync, statSync } from 'node:fs';
import type { Logger } from '../contracts.ts';
import type { RootEvent, RootWatcher } from '../root/watcher.ts';
import type { VectorEmbedResult, VectorSearchInput, VectorSearchResult } from '../../shared/model/vectors.ts';
import type { Db } from '../db/database.ts';
import { forgetBlobsBelow, noteBlobs, scanChanged, treeFiles } from './memory-blobs.ts';
import { MEMORY_ENTRY, type MemoryTree } from './memory-tree.ts';

/** The tree's files are named to the vectors in batches, each with this budget per pass until nothing remains of it. */
const EMBED_BATCH = 500;
const EMBED_PASS_MS = 30_000;
const EMBED_PASSES = 20;
/** A failed embedding model (unreachable, still downloading): the tree is tried again this much later. */
const EMBED_RETRY_MS = 5 * 60_000;

/** What this store needs of services.vectors (absolute paths; the place "memory" is this tree). */
export interface MemoryVectors {
  available(): boolean;
  embed(paths: string[], opts?: { budgetMs?: number; notYet?: boolean }): Promise<VectorEmbedResult & { failed?: boolean }>;
  search(input: VectorSearchInput): Promise<VectorSearchResult>;
  onFileChanged(file: string): unknown;
  onFileRemoved(file: string): unknown;
}

const isEmbedded = (rel: string): boolean => /\.md$/i.test(rel) && !rel.split('/').some((part) => part.startsWith('.') || part.startsWith('_'));

export class MemoryFollow {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly tree: MemoryTree;
  private readonly vectors: () => MemoryVectors | undefined;
  private readonly log?: Logger;
  private readonly retryMs: number;
  private unwatch?: () => void;
  private embedding?: Promise<void>;
  /** The folders waiting for a pass ('' = the whole tree). */
  private readonly due = new Set<string>();
  /** The folders a pass has been through. */
  private readonly walked = new Set<string>();
  private retry?: ReturnType<typeof setTimeout>;
  private embedderUp = false;
  private following = false;

  constructor(deps: { db: Db; now: () => number; tree: MemoryTree; vectors: () => MemoryVectors | undefined; log?: Logger; retryMs?: number }) {
    this.db = deps.db;
    this.now = deps.now;
    this.tree = deps.tree;
    this.vectors = deps.vectors;
    this.log = deps.log;
    this.retryMs = deps.retryMs ?? EMBED_RETRY_MS;
  }

  /** Resolves when the tree's blob names are current (embedding goes on in the background). */
  start(watcher?: Pick<RootWatcher, 'register'>): Promise<void> {
    this.unwatch ??= watcher?.register(MEMORY_ENTRY, (event) => this.outsideChange(event));
    this.following = true;
    void this.embedTree();
    return scanChanged(this.db, this.tree.root, this.now());
  }

  stop(): void {
    this.unwatch?.();
    this.unwatch = undefined;
    this.following = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
  }

  /** A settings change may have brought an embedding model: what is not embedded yet is, now. */
  embedderChanged(): void {
    const up = this.vectors()?.available() === true;
    if (up && !this.embedderUp) void this.embedTree();
    this.embedderUp = up;
  }

  changed(rel: string): void {
    this.noteBlobs(rel);
    if (isEmbedded(rel)) this.tell(rel, (vectors, file) => vectors.onFileChanged(file));
  }

  removed(rel: string): void {
    this.noteBlobs(rel);
    if (isEmbedded(rel)) this.tell(rel, (vectors, file) => vectors.onFileRemoved(file));
  }

  /** Never stops a memory write. */
  private noteBlobs(rel: string): void {
    try {
      const entry = this.tree.exists(rel) ? this.tree.raw(rel) : undefined;
      noteBlobs(this.db, rel, entry, this.now());
    } catch (error) {
      this.log?.warn('memory: the stored files of a memory file were not noted', { file: rel, error: String(error) });
    }
  }

  /** Vectors never stop a memory write (a failed update is found again by the mtime check of the next search). */
  private tell(rel: string, call: (vectors: MemoryVectors, file: string) => unknown): void {
    const vectors = this.vectors();
    if (!vectors) return;
    const failed = (error: unknown) => this.log?.warn('memory: vector update failed', { file: rel, error: String(error) });
    try { void Promise.resolve(call(vectors, this.tree.abs(rel))).catch(failed); } catch (error) { failed(error); }
  }

  /** The watcher reports a change in the tree. */
  private outsideChange(event: RootEvent): void {
    if (!event.parts) { void this.embedTree(); return; } // unknown: check everything
    const rel = event.parts.join('/'); // '': the tree itself, also reported when a folder comes directly below it
    if (event.parts.some((part) => part.startsWith('.'))) return;
    if (/\.md$/i.test(rel)) {
      if (existsSync(this.tree.abs(rel))) this.changed(rel);
      else this.removed(rel);
      return;
    }
    const info = statSync(this.tree.abs(rel), { throwIfNoEntry: false });
    if (info?.isDirectory()) { if (!this.walked.has(rel)) void this.embedTree(rel); } // a folder came or was renamed
    else if (!rel) { if (!info) this.walked.clear(); } // the tree went: what comes back is new; its vectors go when a search finds the files gone
    else if (!info) { // a folder went: everything below it
      for (const folder of this.walked) if (folder === rel || folder.startsWith(`${rel}/`)) this.walked.delete(folder);
      try { forgetBlobsBelow(this.db, rel); } catch { /* the next pass looks again */ }
      this.tell(rel, (vectors, file) => vectors.onFileRemoved(file));
    }
  }

  /** Embeds what is not embedded yet in the tree or one new folder, one run at a time; a call during a run brings one more (the run may have passed that folder). Never throws. */
  private embedTree(folder = ''): Promise<void> {
    this.due.add(folder);
    this.embedding ??= (async () => {
      while (this.due.size) {
        const next = this.due.has('') ? '' : this.due.values().next().value!;
        if (!next) this.due.clear();
        else this.due.delete(next);
        if (!next || !this.walked.has(next)) await this.embedFiles(next);
      }
    })().finally(() => { this.embedding = undefined; });
    return this.embedding;
  }

  /** The model failed: not again now, the whole tree a while later (while the tree is followed). */
  private embedLater(): void {
    if (!this.following || this.retry) return;
    this.retry = setTimeout(() => { this.retry = undefined; void this.embedTree(); }, this.retryMs);
    (this.retry as { unref?: () => void }).unref?.();
  }

  /** Every entry file by name (vectors skip what is unchanged): a topic folder called "build" or a note about tokens is memory too. The walk never stops the event loop. */
  private async embedFiles(folder = ''): Promise<void> {
    const vectors = this.vectors();
    this.embedderUp = vectors?.available() === true;
    if (!vectors || !this.embedderUp) return;
    try {
      let batch: string[] = [];
      this.walked.add(folder);
      for await (const rel of treeFiles(this.tree.root, folder)) {
        for (let at = rel.lastIndexOf('/'); at > 0; at = rel.lastIndexOf('/', at - 1)) { // the walk comes through folders in turn: most are known at once
          if (this.walked.has(rel.slice(0, at))) break;
          this.walked.add(rel.slice(0, at));
        }
        if (!isEmbedded(rel)) continue;
        batch.push(this.tree.abs(rel));
        if (batch.length >= EMBED_BATCH) {
          if (!(await this.embedBatch(vectors, batch))) return;
          batch = [];
        }
      }
      if (batch.length) await this.embedBatch(vectors, batch);
    } catch (error) {
      this.log?.warn('memory: embedding the tree failed', { error: String(error) });
    }
  }

  /** One batch until nothing remains of it; false when the model failed (the tree comes again later). */
  private async embedBatch(vectors: MemoryVectors, batch: string[]): Promise<boolean> {
    for (let pass = 0; pass < EMBED_PASSES; pass++) {
      const result = await vectors.embed(batch, { budgetMs: EMBED_PASS_MS, notYet: true });
      if (result.failed) { this.embedLater(); return false; }
      if (!result.remaining) break;
    }
    return true;
  }
}
