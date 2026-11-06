// Row sync between linked PCs (mesh method 'sync.rows'; the tables: tables.ts, the clock: stamps.ts). A change
// here – heard on the services' own events – becomes one stamped row that goes to every linked PC it is for
// (a CEO PC: all; an employee's PC: the chats its person is or was in, their messages and the tasks they may read – tables.ts)
// within FLUSH_MS: a row that changes again before then goes once, in its latest state (a streaming answer's live
// values change about twice a second). A row naming a stored file (its sha256 id) takes that file's row along, as
// do the settings; a memory file's event takes its old versions along (rows of their own). A PC that is not online
// gets it at its next link-up, which sends every stamp stored after that PC's cursor (all rows the first time); rows
// that never travelled (stored files, knowledge rows, plan logins a PC found – they travel since 04.11.2026) get
// their stamp when the sync attaches, so a link that has a cursor gets them too. An incoming row that wins is written with its stamp in one transaction – so
// the service events after it find nothing new and nothing echoes back – and is passed on to the other CEO PCs, never back to the sender; a
// row that is already there stops there. An employee's PC gets its person's part in their ids and sends back only
// what that person did there – their lines, their changes of their tasks – which the CEO's PC checks, delivers like
// a line from their phone and passes on (employee.ts) – a status change of their task runs the task service's own path
// here (follow-ups, wakes); its employer's batch holds only chats, messages and tasks, and goes on to my other PCs with
// its `origin` (B-078: all my devices are the same employee there).
// Whom a message wakes is decided once, on the PC where it was written; the due wakes of an
// agent whose turns run on another PC (home.ts) go there after the rows they name (through a CEO PC that knows that
// home, when this one does not), so it wakes like for a local one. A PC that joins the CEO's company retires its own
// untouched first-run Manager once the company's agents are here.
// Owns: the outbox, batches, catch-up, the wake hand-over. Never: logs a row's content, runs an agent.

import type { RuntimeServices, Wake, WakeRequest } from '../../contracts.ts';
import type { EventName } from '../../../shared/api/events.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { chatWakeKey } from '../../chat/delivery-route.ts';
import { DevicesRepo } from '../repo.ts';
import { asPerson, goesBack, heldStatus, markOrigin, moveStatus, noteSent, ownTodos, takenFrom, theirMaker, type StatusMove } from './employee.ts';
import { homeElsewhere, linkOf, links, selfId } from './home.ts';
import { compared, placeSchedules, readRow, TABLE, TABLES, upsert, type Apply, type Wire } from './tables.ts';
import { hashOf, wins, type Stamp, type Stamps } from './stamps.ts';

/**
 * One row as it travels; `first`: part of a first link-up's history (it stays that when passed on); `origin`: the
 * employer's PC it came from, when one of my PCs passes it on to my other PCs (they mark it the same way, employee.ts).
 */
export interface Item { t: string; id: string; at: number; row?: Wire; gone?: true; first?: true; origin?: string }
interface HandOver { requests: WakeRequest[]; done(ok: boolean): void }
interface Box { items: Map<string, Item>; wakes: HandOver[] }

/** Events that name a changed row: [event, table, removed, the field with its id or ids (default id)]. */
const EVENTS: ReadonlyArray<readonly [EventName, string, boolean, string?]> = [
  ['space.upserted', 'spaces', false], ['person.upserted', 'people', false], ['conversation.upserted', 'conversations', false],
  ['conversation.removed', 'conversations', true], ['agent.upserted', 'agents', false], ['task.upserted', 'tasks', false],
  ['task.removed', 'tasks', true], ['schedule.upserted', 'schedules', false], ['schedule.removed', 'schedules', true],
  ['account.upserted', 'accounts', false], ['account.removed', 'accounts', true],
  ['message.created', 'messages', false], ['message.updated', 'messages', false], ['message.removed', 'messages', true],
  ['notes.updated', 'chat_notes', false, 'conversationId'],
  ['knowledge.upserted', 'knowledge', false], ['knowledge.removed', 'knowledge', true, 'ids'],
];
/** How long changed rows gather before they go (one call per PC, each row once in its latest state). */
export const FLUSH_MS = 300;
/** Rows that travel since 04.11.2026 and may never have travelled: [table, which rows]. */
const UNSENT: ReadonlyArray<readonly [string, string]> = [['files', '1'], ['accounts', "t.detected = 1 AND t.auth = 'cli'"], ['knowledge', '1']];
/** A stored file's id (a sha256) in a row's text. */
const FILE_ID = /\b[a-f0-9]{64}\b/g;
const keyOf = (name: string) => TABLE.get(name)?.key ?? 'id';
/** Characters of one call (the channel takes frames up to 8 MiB). */
const MAX_CALL = 1_000_000;
const PAGE = 200;
const ORDER = new Map(TABLES.map((table, index) => [table.name, index]));

const errorText = (error: unknown) => String((error as Error)?.message ?? error);

function chunks(items: Item[]): Item[][] {
  const out: Item[][] = [];
  let current: Item[] = [];
  let size = 0;
  for (const item of items) {
    const length = JSON.stringify(item).length;
    if (current.length && size + length > MAX_CALL) { out.push(current); current = []; size = 0; }
    current.push(item);
    size += length;
  }
  if (current.length) out.push(current);
  return out;
}

function valid(item: unknown): item is Item {
  const value = item as Item;
  return Boolean(value) && typeof value.t === 'string' && TABLE.has(value.t) && typeof value.id === 'string' && value.id.length <= 200
    && typeof value.at === 'number' && (value.gone === true || (Boolean(value.row) && typeof value.row === 'object' && value.row![keyOf(value.t)] === value.id));
}

const byOrder = (a: Item, b: Item) => (ORDER.get(a.t)! - ORDER.get(b.t)!) || (Number(a.row?.created_at ?? 0) - Number(b.row?.created_at ?? 0));
const request = (wake: Wake): WakeRequest => ({ agentId: wake.agentId, reason: wake.reason, conversationId: wake.conversationId, taskId: wake.taskId, note: wake.note, origin: wake.origin });

export class RowSync {
  private readonly s: RuntimeServices;
  private readonly stamps: Stamps;
  private readonly outbox = new Map<string, Box>();
  private flushing?: ReturnType<typeof setTimeout>;
  private readonly flushMs: number;
  /** Agents whose wakes are on their way, and those whose hand-over failed (again at the next link-up). */
  private readonly moving = new Set<string>();
  private readonly holding = new Set<string>();

  /** `flushMs`: how long changes gather (FLUSH_MS; tests 0). */
  constructor(s: RuntimeServices, stamps: Stamps, flushMs = FLUSH_MS) {
    this.s = s;
    this.stamps = stamps;
    this.flushMs = flushMs;
  }

  /** Stamps the rows that never travelled, then listens to the services' events, the settings (the stored files they name) and the due wakes; returns the off switch. */
  attach(): () => void {
    this.stampUnsent();
    const offs = EVENTS.map(([event, table, gone, field = 'id']) => this.s.bus.on(event, (data: unknown) => {
      const value = (data as Record<string, unknown> | undefined)?.[field];
      for (const id of Array.isArray(value) ? value : [value]) this.changed(table, String(id ?? ''), gone);
    }));
    // A memory file's old versions name it in `supersedes` (a new one, or all of them when the file moved).
    offs.push(this.s.bus.on('knowledge.upserted', (item) => {
      for (const { id } of this.s.db.all<{ id: string }>('SELECT id FROM knowledge WHERE supersedes = ?', [item.id])) this.changed('knowledge', id, false);
    }));
    offs.push(this.s.bus.on('settings.updated', (settings) => this.filesIn(settings)));
    offs.push(this.s.scheduler.onDueWakes((agentIds) => { for (const id of agentIds) this.handOver(id); }));
    return () => { for (const off of offs) off(); };
  }

  /** A link came up: wakes that waited for it go now. */
  resume(): void {
    this.holding.clear();
    for (const id of this.s.wakes.dueAgents()) this.handOver(id);
  }

  /** A stored file's row as it travels (stamped and on its way first when it never went): a media tab of another PC takes it along (paths.ts). */
  fileItem(id: string): Item | undefined {
    this.changed('files', id, false);
    const stamp = this.stamps.get(`files/${id}`);
    const row = readRow(this.s, TABLE.get('files')!, id, selfId(this.s.db));
    return stamp && row ? { t: 'files', id, at: stamp.at, row } : undefined;
  }

  // ---------------------------------------------------------------- sending

  /** Rows that never travelled (UNSENT, no stamp yet) get one now: the next link-up sends them (stored after its cursor). */
  private stampUnsent(): void {
    const self = selfId(this.s.db);
    for (const [name, where] of UNSENT) {
      const table = TABLE.get(name)!;
      try {
        for (const id of this.stamps.unstamped(name, keyOf(name), where)) {
          const row = readRow(this.s, table, id, self);
          if (row) this.stamps.set(`${name}/${id}`, this.stamps.next(undefined, hashOf(compared(table, row))));
        }
      } catch (error) {
        this.s.log.warn('sync rows not stamped', { table: name, error: errorText(error) });
      }
    }
  }

  private changed(name: string, id: string, gone: boolean): void {
    const table = TABLE.get(name)!;
    if (!id) return;
    try {
      if (name === 'agents') placeSchedules(this.s, id); // its home may have moved (here or on another PC)
      if (!gone) table.settle?.(id, this.s);
      const row = gone ? undefined : readRow(this.s, table, id, selfId(this.s.db));
      if (!gone && !row) return; // it stays here (an environment key found here) or went already
      if (row && name !== 'files') this.filesIn(row);
      const key = `${name}/${id}`;
      const h = row ? hashOf(compared(table, row)) : '';
      const r = row && table.merged ? hashOf(table.merged.part(row)) : undefined;
      const old = this.stamps.get(key);
      if (old && old.h === h && Boolean(old.gone) === gone) {
        if (!row || r === undefined || old.r === r) return; // nothing that travels changed (also the echo of a row just written)
        // Only the merged part moved (a read): no edit, the same stamp – the row goes to my own PCs, which merge it.
        this.stamps.set(key, { ...old, r });
        this.send({ t: name, id, at: old.at, row }, undefined, true);
        return;
      }
      const stamp: Stamp = { ...this.stamps.next(old, h, gone), ...(r === undefined ? {} : { r }) };
      this.stamps.set(key, stamp);
      this.send({ t: name, id, at: stamp.at, ...(row ? { row } : { gone: true as const }) });
    } catch (error) {
      this.s.log.warn('sync change not recorded', { table: name, id, error: errorText(error) });
    }
  }

  /** The rows of the stored files `value` names go first (only those this PC has; each once, by its stamp). */
  private filesIn(value: unknown): void {
    for (const id of new Set(JSON.stringify(value ?? null).match(FILE_ID) ?? [])) this.changed('files', id, false);
  }

  private send(item: Item, except?: string, mineOnly = false): void {
    const table = TABLE.get(item.t)!;
    for (const { record, link } of links(this.s.db)) {
      if (record.id === except || ((item.origin || mineOnly) && link.kind !== 'ceo')) continue; // an employer's row (or a read) goes on only to my own PCs
      if (link.kind === 'employer' && !goesBack(item, record.id, this.s.db, this.s.clock.now())) continue; // an employee's PC sends back only its person's own part
      if (link.kind === 'employee' && !(table.employee && (item.gone || table.employee(item.row!, link.personId, this.s.db)))) continue;
      this.box(record.id).items.set(`${item.t}/${item.id}`, link.kind === 'employee' ? asPerson(item, link.personId, true) : item);
    }
    this.later();
  }

  private box(peer: string): Box {
    let box = this.outbox.get(peer);
    if (!box) this.outbox.set(peer, (box = { items: new Map(), wakes: [] }));
    return box;
  }

  private later(): void {
    if (this.flushing) return;
    this.flushing = setTimeout(() => { this.flushing = undefined; void this.flush(); }, this.flushMs);
    (this.flushing as { unref?: () => void }).unref?.();
  }

  private async flush(): Promise<void> {
    const boxes = [...this.outbox];
    this.outbox.clear();
    await Promise.all(boxes.map(async ([peer, box]) => {
      const ok = this.s.devices.online(peer) && await this.post(peer, [...box.items.values()], box.wakes.flatMap((handOver) => handOver.requests));
      for (const handOver of box.wakes) handOver.done(ok);
    }));
  }

  /** Sends rows (in calls of at most MAX_CALL characters), then the wakes; false when a call failed. */
  private async post(peer: string, items: Item[], wakes: WakeRequest[] = []): Promise<boolean> {
    try {
      for (const chunk of chunks(items)) await this.s.devices.call(peer, 'sync.rows', { items: chunk });
      if (linkOf(new DevicesRepo(this.s.db).get(peer))?.kind === 'employee') noteSent(this.s.db, peer, items, this.s.clock.now()); // the statuses their PC has now
      if (wakes.length) await this.s.devices.call(peer, 'sync.rows', { wakes });
      return true;
    } catch (error) {
      this.s.log.info('sync rows not sent', { peer, rows: items.length, error: errorText(error) });
      return false;
    }
  }

  /** Every row the link-up owes `peer`: all of them the first time (`since` undefined), else what was stamped after `since`. */
  async catchUp(peer: string, since: number | undefined): Promise<boolean> {
    const link = linkOf(new DevicesRepo(this.s.db).get(peer));
    if (!link) return true;
    const self = selfId(this.s.db);
    let ok = true;
    const flush = async (items: Item[]) => { if (items.length) ok = (await this.post(peer, items)) && ok; };
    for (const table of TABLES) {
      if (link.kind !== 'ceo' && !table.employee) continue;
      const take = (id: string, stamp: Stamp | undefined): Item | undefined => {
        if (!stamp?.gone) table.settle?.(id, this.s);
        const row = stamp?.gone ? undefined : readRow(this.s, table, id, self);
        if (!row && !stamp?.gone) return undefined;
        if (row && link.kind === 'employee' && !table.employee!(row, link.personId, this.s.db)) return undefined;
        const item: Item = { t: table.name, id, at: stamp?.at ?? 0, ...(row ? { row } : { gone: true as const }), ...(since === undefined && link.kind !== 'employer' ? { first: true as const } : {}) };
        if (link.kind === 'employer') return goesBack(item, peer, this.s.db, this.s.clock.now()) ? item : undefined; // the person's own part that waited for the link
        return link.kind === 'employee' ? asPerson(item, link.personId, true) : item;
      };
      if (link.kind === 'employer') { // only rows changed here since the cursor can be this person's own – and, the first time, their open to-dos
        const changed = this.stamps.since(`${table.name}/`, since ?? -1).map(({ key, stamp }) => take(key.slice(table.name.length + 1), stamp));
        const keys = new Set(changed.map((item) => item?.id));
        const todos = table.name === 'tasks' && since === undefined ? ownTodos(this.s.db, peer).filter((id) => !keys.has(id)).map((id) => take(id, this.stamps.get(`tasks/${id}`))) : [];
        await flush([...changed, ...todos].filter((item): item is Item => Boolean(item)));
        continue;
      }
      if (since === undefined) {
        for (let after = 0; ;) {
          const page = this.s.db.all<{ id: string; r: number }>(`SELECT ${keyOf(table.name)} AS id, rowid AS r FROM ${table.name} WHERE rowid > ? ORDER BY rowid LIMIT ?`, [after, PAGE]);
          if (!page.length) break;
          after = Number(page[page.length - 1].r);
          await flush(page.map((row) => take(String(row.id), this.stamps.get(`${table.name}/${row.id}`))).filter((item): item is Item => Boolean(item)));
        }
        continue;
      }
      const changed = this.stamps.since(`${table.name}/`, since);
      for (let index = 0; index < changed.length; index += PAGE) {
        await flush(changed.slice(index, index + PAGE).map(({ key, stamp }) => take(key.slice(table.name.length + 1), stamp)).filter((item): item is Item => Boolean(item)));
      }
    }
    return ok;
  }

  // ---------------------------------------------------------------- receiving

  /** 'sync.rows' from a linked PC: its rows (applied when they win, then passed on) and wakes for agents that run here. */
  async receive(params: unknown, from: string): Promise<{ ok: true; applied: number }> {
    const record = new DevicesRepo(this.s.db).get(from);
    const link = linkOf(record);
    if (!link) throw new WorkforceError('forbidden', 'This PC takes no rows from that PC.');
    const batch = (params ?? {}) as { items?: unknown[]; wakes?: unknown[] };
    const scoped = link.kind === 'employer'; // this PC is that PC's employee: only chats, messages and tasks
    const person = link.kind === 'employee' ? link.personId : undefined; // that PC's person: only their own part (employee.ts)
    let items = (Array.isArray(batch.items) ? batch.items : []).filter(valid).filter((item) => !scoped || Boolean(TABLE.get(item.t)!.employee));
    const moves: StatusMove[] = [];
    if (person) items = items.map((item) => asPerson(item, person, false)).filter((item) => takenFrom(item, person, this.s.db))
      .map((item) => heldStatus(this.s.db, theirMaker(this.s.db, item, person), moves, from));
    items.sort(byOrder);
    const self = selfId(this.s.db);
    const applied: Array<{ item: Item; existed: boolean; ctx: Apply }> = [];
    this.s.db.tx(() => {
      for (const item of items) {
        const ctx: Apply = { s: this.s, first: !person && item.first === true };
        if (scoped) markOrigin(this.s.db, item, from, this.s.clock.now());
        // From my other PC, with the employer it came from: marked even before this PC links that employer (the roster may come later).
        else if (link.kind === 'ceo' && typeof item.origin === 'string' && item.origin.length <= 200 && item.origin !== self) markOrigin(this.s.db, item, item.origin, this.s.clock.now());
        const existed = this.apply(item, ctx, self, Boolean(record?.joinedAs));
        if (existed !== undefined) applied.push({ item, existed, ctx });
      }
    });
    for (const { item, existed, ctx } of applied) {
      if (item.gone) continue;
      try {
        TABLE.get(item.t)!.emit(item.id, ctx, existed);
        // Written on the person's PC, where no agent of this company runs: delivered here, like a line from their phone.
        const message = person && item.t === 'messages' && !existed ? this.s.chats.message(item.id) : undefined;
        if (message) this.s.delivery.onMessage(message);
      } catch (error) { this.s.log.warn('synced row not announced', { table: item.t, id: item.id, error: errorText(error) }); }
    }
    // A person's status change of their task – in a row that won here – runs as one from their phone: its follow-ups and wakes (employee.ts).
    for (const move of moves) if (applied.some(({ item }) => item.t === 'tasks' && item.id === move.id)) moveStatus(this.s, move, person!);
    for (const { item } of applied) this.send(scoped ? { ...item, origin: from } : item, from);
    if (record?.joinedAs === 'ceo' && applied.some(({ item }) => item.t === 'agents' && item.first)) this.retireSeed(record.pairedAt ?? this.s.clock.now());
    if (!person) for (const wake of Array.isArray(batch.wakes) ? batch.wakes : []) this.wakeHere(wake, from);
    return { ok: true, applied: applied.length };
  }

  /**
   * This PC joined the CEO's company and its agents are here: this PC's own first-run Manager, untouched (made here
   * before the link, template 'manager', no message from a person in its chats), is archived and its own chats
   * removed – both travel like any change – so the company keeps one chief of staff.
   */
  private retireSeed(linkedAt: number): void {
    const db = this.s.db;
    const seed = db.get<{ id: string }>(
      `SELECT a.id FROM agents a WHERE a.device_id IS NULL AND a.archived_at IS NULL AND a.template = 'manager' AND a.created_at < ?
         AND NOT EXISTS (SELECT 1 FROM members x JOIN messages m ON m.conversation_id = x.conversation_id WHERE x.member_id = a.id AND m.author_kind = 'human')
       ORDER BY a.created_at LIMIT 1`, [linkedAt])?.id;
    if (!seed || !db.get('SELECT 1 FROM agents WHERE archived_at IS NULL AND id <> ?', [seed])) return;
    try {
      const chats = db.all<{ id: string }>(
        `SELECT conversation_id AS id FROM members WHERE member_id = ?
           AND conversation_id NOT IN (SELECT conversation_id FROM members WHERE kind = 'agent' AND member_id <> ?)`, [seed, seed]);
      this.s.org.archive(seed);
      for (const chat of chats) this.s.chats.remove(chat.id);
      this.s.log.info('own first-run Manager retired', { agentId: seed, chats: chats.length });
    } catch (error) {
      this.s.log.warn('own first-run Manager not retired', { agentId: seed, error: errorText(error) });
    }
  }

  /** Writes one row (or its removal) when it wins; returns whether it existed here, undefined when nothing changed. */
  private apply(item: Item, ctx: Apply, self: string, joined: boolean): boolean | undefined {
    const table = TABLE.get(item.t)!;
    const key = `${item.t}/${item.id}`;
    const existed = Boolean(this.s.db.get(`SELECT 1 FROM ${table.name} WHERE ${keyOf(item.t)} = ?`, [item.id]));
    const current = existed ? readRow(this.s, table, item.id, self) : undefined;
    const local = this.stamps.get(key) ?? (current ? { at: 0, h: hashOf(compared(table, current)) } : undefined);
    const incoming: Stamp = { at: item.at, h: item.gone ? '' : hashOf(compared(table, item.row!)), ...(item.gone ? { gone: true as const } : {}) };
    if ((local && local.h === incoming.h && Boolean(local.gone) === Boolean(item.gone)) || !wins(incoming, local, joined)) {
      // Here already, or older than this PC's: only its merged part (a read cursor) is taken – announced, so it goes on.
      try { if (!item.gone && existed && table.merged?.take(item.row!, ctx)) table.emit(item.id, ctx, true); } catch (error) { this.s.log.warn('synced part not taken', { table: item.t, id: item.id, error: errorText(error) }); }
      return undefined;
    }
    try {
      return this.s.db.tx(() => {
        if (item.gone) {
          this.stamps.set(key, incoming);
          if (existed) table.drop(item.id, ctx);
          return existed;
        }
        const partial = table.write ? table.write(item.row!, ctx, existed) : upsert(this.s.db, table.name, item.row!);
        table.merged?.take(item.row!, ctx);
        const after = readRow(this.s, table, item.id, self);
        // A row written without a reference that was not here yet takes the same row again when it comes back.
        this.stamps.set(key, { at: partial ? item.at - 1 : item.at, h: after ? hashOf(compared(table, after)) : incoming.h, ...(after && table.merged ? { r: hashOf(table.merged.part(after)) } : {}) });
        return existed;
      });
    } catch (error) {
      this.s.log.warn('synced row not applied', { table: item.t, id: item.id, error: errorText(error) });
      return undefined;
    }
  }

  // ---------------------------------------------------------------- wakes

  /** Due wakes of an agent that runs on another PC go there (its home, or every online CEO PC when this PC does not know it). */
  private handOver(agentId: string): void {
    if (this.moving.has(agentId) || this.holding.has(agentId)) return;
    const home = homeElsewhere(this.s, agentId);
    if (!home) return;
    const known = links(this.s.db).filter(({ link }) => link.kind === 'ceo');
    const targets = (known.some(({ record }) => record.id === home) ? [home] : known.map(({ record }) => record.id)).filter((id) => this.s.devices.online(id));
    if (!targets.length) return; // they wait for the link-up
    const wakes = this.s.wakes.claim(agentId);
    if (!wakes.length) return;
    this.moving.add(agentId);
    const requests = wakes.map(request);
    let left = targets.length;
    let sent = false;
    const done = (ok: boolean) => {
      sent ||= ok;
      if (--left) return;
      this.moving.delete(agentId);
      if (sent) { this.s.wakes.done(wakes.map((wake) => wake.id)); return; }
      this.holding.add(agentId);
      this.s.wakes.release(wakes.map((wake) => wake.id), undefined, true); // unannounced: back at the next link-up
    };
    for (const peer of targets) this.box(peer).wakes.push({ requests, done });
    this.later();
  }

  /**
   * A wake from another PC: stored here for an agent that runs here, or for one at home on a CEO PC linked here (not
   * the sender – the dispatcher leaves it, handOver takes it there: a PC that does not know that home sent it here);
   * any other is dropped.
   */
  private wakeHere(raw: unknown, from: string): void {
    const wake = (raw ?? {}) as Partial<WakeRequest>;
    if (typeof wake.agentId !== 'string' || typeof wake.reason !== 'string' || !this.s.org.get(wake.agentId)) return;
    const home = homeElsewhere(this.s, wake.agentId);
    if (home && (home === from || linkOf(new DevicesRepo(this.s.db).get(home))?.kind !== 'ceo')) return;
    const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
    const origin = wake.origin && typeof wake.origin.source === 'string' ? { source: wake.origin.source, label: String(wake.origin.label ?? '') } : undefined;
    const chat = text(wake.conversationId);
    const task = text(wake.taskId);
    // A message's wake merges with any wake for the same chat here (as a delivery here would make it).
    const coalesceKey = wake.reason === 'message' && chat && !task ? chatWakeKey(chat) : `linked:${wake.reason}:${chat ?? ''}:${task ?? ''}`;
    this.s.wakes.wake({ agentId: wake.agentId, reason: wake.reason, conversationId: chat, taskId: task, note: text(wake.note), coalesceKey, ...(origin ? { origin } : {}) });
  }
}
