// The derived chat mirror (B-050 K8 a): <data>/chats/<slug>-<id8>/ with chat.json and
// messages/YYYY-MM.jsonl (format.ts) for every chat – never the app's own chats (settings.system) – plus
// chats/README.md. The database stays the original; the mirror can always be written again from it.
// Driven by the bus: a finished message is appended to its month (message.created, or message.updated
// when a streamed message finishes); an edit, a delete, a move to a new seq (B-047 D4) rewrites that
// month from the database; a title change renames the folder (the id suffix stays); a deleted chat or
// one that became the people's own loses its folder. Changes gather for FLUSH_MS behind one timer and
// are written chat by chat on one lane (shared with the start-up backfill, so nothing writes twice at
// once). A chat's first write and a chat whose folder was deleted by hand are written whole; a line for a month without
// its file (a new month, or one deleted by hand) writes that month from the database. A whole or month
// write never doubles a line written meanwhile (write-marks.ts).
// Start-up backfill: every chat's kv stamp (ns 'chatMirror', folders.ts – stored after each write) is
// compared with the database, PAGE chats at a time; a chat that differs (or has no folder) is written
// whole, one per lane step so live changes go in between. The stamps are the cursor: an interrupted
// start resumes with the chats not yet written. Folders this PC wrote for chats that are gone are
// removed; folders from another PC are never touched.
// Owns: the tree under <data>/chats and the kv stamps. Never: writes the chats themselves, or polls.

import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { Conversation, Message } from '../../shared/model/chat.ts';
import { isAgentNotice } from '../../shared/model/message-changes.ts';
import type { RuntimeServices } from '../contracts.ts';
import { KvRepo } from '../store/kv.ts';
import { chatStamp, folderIndex, writeReadme } from './folders.ts';
import { chatFile, chatFileText, chatFolderName, messageLine, monthOf } from './format.ts';
import { memberNamer } from './names.ts';
import { appendLines, isThere, messagesById, placeChat, shardFile, shardHolding, shardSource, writeAllMonths, writeMonth } from './write.ts';
import { WriteMarks } from './write-marks.ts';

export const FLUSH_MS = 1000;
export const MIRROR_NS = 'chatMirror';
/** Chats whose stamps the backfill compares at once. */
const PAGE = 200;

interface Pending {
  /** Message id → its append number (write-marks.ts: a whole or month write that began after it has the line). */
  appends: Map<string, number>;
  months: Set<string>;
  removed: Set<string>;
  refresh: boolean;
  gone: boolean;
}

export interface ChatMirrorDeps {
  services: () => RuntimeServices;
  /** <data>/chats */
  root: string;
  flushMs?: number;
}

const mirrors = new WeakMap<object, ChatMirror>();

/** The mirror of this runtime (by its database). */
export function chatMirrorOf(s: Pick<RuntimeServices, 'db'>): ChatMirror | undefined {
  return mirrors.get(s.db);
}

export class ChatMirror {
  private readonly deps: ChatMirrorDeps;
  private batch = new Map<string, Pending>();
  /** Messages seen while streaming: their finish appends (a later update rewrites). */
  private readonly streaming = new Set<string>();
  /** Chat id → its folder name under root (only folders this PC wrote). */
  private readonly folders = new Map<string, string>();
  private lane: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private offs: Array<() => void> = [];
  /** Which appends a whole or month write already has (write-marks.ts). */
  private readonly marks = new WriteMarks();
  /** Chats the backfill found behind and has not written yet (their stamp stays until it has). */
  private readonly stale = new Set<string>();
  private stopped = false;

  constructor(deps: ChatMirrorDeps) {
    this.deps = deps;
    mirrors.set(deps.services().db, this);
  }

  /** Listens to the bus and starts the backfill (on the lane, after the folder index). */
  start(): void {
    const bus = this.deps.services().bus;
    this.offs.push(
      bus.on('message.created', (message) => this.created(message)),
      bus.on('message.updated', (message) => this.updated(message)),
      // A removed placeholder that never finished was never written: nothing to look for.
      bus.on('message.removed', ({ id, conversationId }) => { if (!this.streaming.delete(id)) this.pending(conversationId).removed.add(id); }),
      bus.on('conversation.upserted', (chat) => { this.pending(chat.id); }),
      bus.on('conversation.removed', ({ id }) => { this.pending(id).gone = true; }),
    );
    void this.enqueue(() => this.prepare());
    void this.enqueue(() => this.backfill());
  }

  /** Writes the chat whole at the next flush. */
  refresh(chatId: string): void {
    if (!this.stopped) this.pending(chatId).refresh = true;
  }

  /** Writes what is pending and waits for the lane; the backfill stops (the stamps resume it). */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.flush();
    this.stopped = true;
    for (const off of this.offs.splice(0)) off();
    await this.lane;
  }

  /** Resolves once nothing is pending or queued any more (tests). */
  async settled(): Promise<void> {
    for (;;) {
      this.flush();
      const lane = this.lane;
      await lane;
      if (lane === this.lane && !this.batch.size) return;
    }
  }

  private created(message: Message): void {
    if (message.state === 'streaming') { this.streaming.add(message.id); return; }
    this.line(message, false);
  }

  private updated(message: Message): void {
    if (message.state === 'streaming') return;
    this.line(message, !this.streaming.delete(message.id));
  }

  /** A new line is appended; a changed one (or any while its chat or month is written) rewrites its month. */
  private line(message: Message, changed: boolean): void {
    const pending = this.pending(message.conversationId);
    const month = monthOf(message.createdAt);
    const event = changed ? undefined : this.marks.append(message.conversationId, month);
    if (event === undefined) pending.months.add(month);
    else pending.appends.set(message.id, event);
  }

  private pending(chatId: string): Pending {
    let entry = this.batch.get(chatId);
    if (!entry) this.batch.set(chatId, entry = { appends: new Map(), months: new Set(), removed: new Set(), refresh: false, gone: false });
    if (!this.timer && !this.stopped) {
      this.timer = setTimeout(() => this.flush(), this.deps.flushMs ?? FLUSH_MS);
      this.timer.unref?.();
    }
    return entry;
  }

  /** Takes the batch with each chat's stamp in the same tick (so a stamp never counts a change the batch lacks). */
  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.batch.size || this.stopped) return;
    const work = this.batch;
    this.batch = new Map();
    const stamps = new Map([...work.keys()].map((id) => [id, this.stampOf(id)]));
    void this.enqueue(async () => {
      for (const [id, pending] of work) {
        try {
          await this.apply(id, pending, stamps.get(id));
        } catch (error) {
          this.forget(id);
          this.log('chat mirror write failed', { conversationId: id, error: String(error) });
        }
      }
    });
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.lane = this.lane.then(work).catch((error: unknown) => this.log('chat mirror failed', { error: String(error) }));
    return this.lane;
  }

  private async apply(id: string, pending: Pending, stamp: string | undefined): Promise<void> {
    const s = this.deps.services();
    const chat = s.chats.get(id);
    if (pending.gone || !chat || !this.mirrored(s, chat)) { await this.drop(id); return; }
    const before = this.folders.get(id);
    if (pending.refresh || before === undefined || !(await isThere(path.join(this.deps.root, before)))) {
      if (!this.stopped) await this.rebuild(s, chat); // at shutdown: the next start's backfill writes it
      else this.forget(id);
      return;
    }
    const folder = await this.place(s, chat);
    const src = shardSource(s);
    const months = new Set(pending.months);
    for (const removed of pending.removed) {
      const month = await shardHolding(folder, removed);
      if (month) months.add(month);
    }
    const byMonth = new Map<string, string[]>();
    for (const message of messagesById(s.db, [...pending.appends.keys()])) {
      const month = monthOf(message.createdAt);
      // Still streaming, an agents' change notice (never written, write.ts), rewritten below, or in a whole or month write that began after it.
      if (message.state === 'streaming' || isAgentNotice(message) || months.has(month) || this.marks.covered(id, month, pending.appends.get(message.id)!)) continue;
      byMonth.set(month, [...(byMonth.get(month) ?? []), JSON.stringify(messageLine(message, src.nameOf, src.redact))]);
    }
    for (const [month, lines] of byMonth) {
      if (await isThere(shardFile(folder, month))) await appendLines(folder, month, lines);
      else months.add(month); // a new month, or its file was deleted by hand: written from the database
    }
    for (const month of months) await this.marks.writeMonth(id, month, () => writeMonth(src, folder, id, month));
    if (stamp !== undefined && !this.stale.has(id)) new KvRepo(s.db).set(MIRROR_NS, id, stamp, s.clock.now());
  }

  /** Writes the chat whole; lines arriving meanwhile become month rewrites. */
  private async rebuild(s: RuntimeServices, chat: Conversation): Promise<void> {
    const stamp = this.stampOf(chat.id);
    await this.marks.writeWhole(chat.id, async () => writeAllMonths(shardSource(s), await this.place(s, chat), chat.id));
    new KvRepo(s.db).set(MIRROR_NS, chat.id, stamp, s.clock.now());
    this.stale.delete(chat.id);
  }

  /** The chat's folder under its current title (renamed when the title moved on) with a current chat.json. */
  private async place(s: RuntimeServices, chat: Conversation): Promise<string> {
    const file = chatFile(s, chat, memberNamer(s));
    const name = chatFolderName(file);
    const folder = await placeChat(this.deps.root, this.folders.get(chat.id), name, chatFileText(file));
    this.folders.set(chat.id, name);
    return folder;
  }

  private async drop(id: string): Promise<void> {
    const name = this.folders.get(id);
    this.folders.delete(id);
    this.marks.forget(id);
    this.forget(id);
    if (name) await rm(path.join(this.deps.root, name), { recursive: true, force: true });
  }

  private forget(id: string): void {
    try { new KvRepo(this.deps.services().db).delete(MIRROR_NS, id); } catch { /* database closed */ }
  }

  /** README.md and the index of the folders this PC wrote (chat.json id and origin). */
  private async prepare(): Promise<void> {
    await writeReadme(this.deps.root);
    let self: string | undefined;
    try { self = this.deps.services().devices?.self().id; } catch { self = undefined; }
    for (const [id, name] of await folderIndex(this.deps.root, self)) this.folders.set(id, name);
  }

  /** Compares every chat's stamp; chats behind are written by catchUp, one per lane step. */
  private async backfill(): Promise<void> {
    const s = this.deps.services();
    const kv = new KvRepo(s.db);
    const hidden: string[] = [];
    for (let after = ''; !this.stopped;) {
      const ids = s.db.all<{ id: string }>('SELECT id FROM conversations WHERE id > ? ORDER BY id LIMIT ?', [after, PAGE]).map((row) => row.id);
      for (const id of ids) {
        const chat = s.chats.get(id);
        if (!chat) continue;
        if (!this.mirrored(s, chat)) { if (this.folders.has(id)) hidden.push(id); continue; }
        if (!this.folders.has(id) || kv.get<string>(MIRROR_NS, id) !== this.stampOf(id)) this.stale.add(id);
      }
      if (ids.length < PAGE) break;
      after = ids[ids.length - 1];
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (this.stopped) return;
    for (const id of hidden) await this.drop(id);
    for (const [id] of [...this.folders]) if (!s.chats.get(id)) await this.drop(id);
    s.db.run('DELETE FROM kv WHERE ns = ? AND key NOT IN (SELECT id FROM conversations)', [MIRROR_NS]);
    void this.enqueue(() => this.catchUp());
  }

  /** Writes the next chat the backfill found behind, then queues itself again (live changes go in between). */
  private async catchUp(): Promise<void> {
    const id = this.stale.values().next().value;
    if (id === undefined || this.stopped) return;
    const s = this.deps.services();
    const chat = s.chats.get(id);
    try {
      if (chat && this.mirrored(s, chat)) await this.rebuild(s, chat);
    } catch (error) {
      this.forget(id);
      this.log('chat mirror backfill failed', { conversationId: id, error: String(error) });
    }
    this.stale.delete(id);
    void this.enqueue(() => this.catchUp());
  }

  private mirrored(s: RuntimeServices, chat: Conversation): boolean {
    return !chat.settings.system;
  }

  private stampOf(id: string): string {
    return chatStamp(this.deps.services().db, id);
  }

  private log(message: string, data: Record<string, unknown>): void {
    try { this.deps.services().log.warn(message, data); } catch { /* no log */ }
  }
}
