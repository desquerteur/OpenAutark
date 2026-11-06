// A call is one value in its chat (owner 04.11.2026: "ein Anrufprotokoll … auf diese Bubble … draufklicken und dann sieht
// man das"): one quiet status row per call, written only here – by the PC of the device the person calls from. calls.start
// opens it (or returns the device's call already open in that chat); its meta.call (shared/model/call.ts CallRecord) is the
// call: id, the device (participant 'device:<key>', name), startedAt, endedAt and the lines. While it is open, every line
// that comes after the row in that chat is appended – the person's spoken and typed lines and every agent's answer, also an
// answer synced from the agent's home PC (the bus events fire for synced rows too); a quiet line only when it carries this
// call's id (the talker's held line, realtime transcripts, the hand-over note). The newest CALL_LINES stay. The row syncs like
// any message, and one writer means no conflicts. The call ends with calls.end, its device's connection closing, or this
// runtime stopping: what is open then is ended at the next start (endLeftOpen, at its last line) so the end travels too.
// A line follows its row for good, also after the call: an edit gives it the new text, a deletion takes it out – in every
// call row this PC wrote (CallRecord.pc), also when the change arrives by sync.
// Owns: the open calls, their rows and lines, and the list of them kept for the next start (kv 'calls'/'open').
// Never: audio, wakes, another PC's call row or a line's own row.

import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID, SYSTEM_ID, newId } from '../../shared/ids.ts';
import { CALL_LINES, CALL_LINE_TEXT, callRecord, type CallDevice, type CallLine, type CallRecord } from '../../shared/model/call.ts';
import type { Message } from '../../shared/model/chat.ts';
import type { RuntimeServices } from '../contracts.ts';
import { MessageRepo } from '../chat/message-repo.ts';
import { DevicesRepo } from '../devices/repo.ts';
import { KvRepo } from '../store/kv.ts';

const KV_NS = 'calls';
const KV_KEY = 'open';
/** The call rows of a chat whose lines name a message (its id in quotes). */
const LISTING = `SELECT id FROM messages WHERE conversation_id = ? AND kind = 'status' AND instr(meta, ?) > 0`;

interface OpenCall { id: string; rowId: string; conversationId: string; device: CallDevice; seq: number; off: () => void }

const quiet = <T>(read: () => T, fallback: T): T => { try { return read(); } catch { return fallback; } };

/** Who said a line, as the transcript names them. */
function speaker(s: RuntimeServices, call: OpenCall, message: Message): Pick<CallLine, 'from' | 'name'> {
  if (message.authorKind === 'agent') return { from: `agent:${message.authorId}`, name: quiet(() => s.org.get(message.authorId)?.name, undefined) ?? 'Agent' };
  if (message.authorId === HUMAN_ID) {
    const said = message.meta.call?.participant;
    return { from: said ?? `device:${call.device.key}`, name: quiet(() => s.settings.get().profile?.name?.trim(), undefined) || 'You' };
  }
  return { from: `${message.authorKind}:${message.authorId}`, name: quiet(() => s.people?.get(message.authorId)?.name, undefined) ?? message.authorId };
}

/** A row's words as its call line keeps them (a status row: its line), capped; undefined when it says nothing. */
function lineText(message: Message): string | undefined {
  const clean = (message.kind === 'status' ? message.meta.status?.text : message.body)?.trim();
  return clean && clean.length > CALL_LINE_TEXT ? `${clean.slice(0, CALL_LINE_TEXT - 1)}…` : clean || undefined;
}

/** The line a chat row adds to an open call, or undefined. */
function lineOf(s: RuntimeServices, call: OpenCall, message: Message): CallLine | undefined {
  if (message.conversationId !== call.conversationId || message.id === call.rowId || message.state !== 'final' || message.seq <= call.seq) return undefined;
  const marked = message.meta.call?.id === call.id || message.meta.status?.details?.callId === call.id;
  const counts = message.kind === 'status' ? marked : message.kind === 'text' && (marked || !message.silent);
  const text = counts ? lineText(message) : undefined;
  return text ? { at: message.createdAt, ...speaker(s, call, message), text, messageId: message.id } : undefined;
}

/** This PC's device id (CallRecord.pc), undefined without a device record. */
const thisPc = (s: RuntimeServices) => quiet(() => new DevicesRepo(s.db).self()?.id, undefined);

export class CallLog {
  private readonly services: () => RuntimeServices;
  private readonly calls = new Map<string, OpenCall>();
  private readonly listening: Array<() => void>;

  constructor(services: () => RuntimeServices) {
    this.services = services;
    const bus = this.s.bus;
    this.listening = [
      bus.on('message.created', (message) => this.heard(message)),
      bus.on('message.updated', (message) => {
        this.heard(message);
        if (message.editedAt !== undefined && message.state === 'final' && !callRecord(message)) this.follow(message.conversationId, message.id, message);
      }),
      bus.on('message.removed', ({ id, conversationId }) => this.follow(conversationId, id)),
    ];
  }

  private get s(): RuntimeServices { return this.services(); }

  /**
   * This device's call in the chat: the one `callId` names or the one open there, else a new row. `signal`: the device's
   * connection – its closing ends a new call. Throws not_found for an unknown chat.
   */
  start(conversationId: string, device: CallDevice, signal?: AbortSignal, callId?: string): string {
    const mine = (call: OpenCall | undefined) => call && call.conversationId === conversationId && call.device.key === device.key ? call : undefined;
    const open = mine(callId ? this.calls.get(callId) : undefined) ?? [...this.calls.values()].find((call) => mine(call));
    if (open) return open.id;
    const s = this.s;
    if (!s.chats.get(conversationId)) throw new WorkforceError('not_found', 'Chat not found.', { details: { conversationId } });
    const now = s.clock.now();
    const id = newId('call', now);
    const text = `Call from ${device.name}`;
    const pc = thisPc(s);
    const record: CallRecord = { id, participant: `device:${device.key}`, name: device.name, ...(pc ? { pc } : {}), startedAt: now, lines: [] };
    const row = s.chats.send({ conversationId, body: text, kind: 'status', silent: true, authorId: SYSTEM_ID, authorKind: 'system', mentions: [], meta: { status: { type: 'note', text }, call: record } });
    const ended = () => this.end(id);
    signal?.addEventListener('abort', ended, { once: true });
    const call: OpenCall = { id, rowId: row.id, conversationId, device, seq: row.seq, off: () => signal?.removeEventListener('abort', ended) };
    this.calls.set(id, call);
    this.remember(row.id, true);
    if (signal?.aborted) this.end(id);
    return id;
  }

  /** Ends an open call (a device key: only that device's – another device's call is not its to end). */
  end(callId: string, deviceKey?: string): void {
    const call = this.calls.get(callId);
    if (!call) return;
    if (deviceKey !== undefined && call.device.key !== deviceKey) throw new WorkforceError('forbidden', 'This call belongs to another device.');
    this.calls.delete(callId);
    call.off();
    this.write(call.rowId, (record) => ({ ...record, endedAt: this.s.clock.now() }));
    this.remember(call.rowId, false);
  }

  /** Shutdown: the calls are let go; their rows end at the next start (endLeftOpen), when the end can travel. */
  stop(): void {
    for (const call of this.calls.values()) call.off();
    this.calls.clear();
    for (const off of this.listening.splice(0)) off();
  }

  /** Start-up: the calls this PC left open (a stop or a crash) end at their last line. Returns how many. */
  endLeftOpen(): number {
    const kv = new KvRepo(this.s.db);
    const left = kv.get<string[]>(KV_NS, KV_KEY) ?? [];
    let ended = 0;
    for (const rowId of Array.isArray(left) ? left : []) {
      if (this.write(rowId, (record) => (record.endedAt === undefined ? { ...record, endedAt: record.lines.at(-1)?.at ?? record.startedAt } : record))) ended++;
    }
    kv.delete(KV_NS, KV_KEY);
    return ended;
  }

  // ------------------------------------------------------------------ internals

  /** The rows of open calls, kept for the next start (endLeftOpen): a call row joins on start and leaves when it ends. */
  private remember(rowId: string, open: boolean): void {
    const kv = new KvRepo(this.s.db);
    const known = kv.get<string[]>(KV_NS, KV_KEY);
    const rows = [...(Array.isArray(known) ? known : []).filter((entry) => entry !== rowId), ...(open ? [rowId] : [])];
    if (rows.length) kv.set(KV_NS, KV_KEY, rows, this.s.clock.now()); else kv.delete(KV_NS, KV_KEY);
  }

  /** A final row of an open call's chat after its row joins its lines (once; edits come through follow). */
  private heard(message: Message): void {
    for (const call of [...this.calls.values()]) {
      const line = lineOf(this.s, call, message);
      if (line) this.write(call.rowId, (record) => (record.lines.some((entry) => entry.messageId === line.messageId) ? record : { ...record, lines: [...record.lines, line].slice(-CALL_LINES) }));
    }
  }

  /**
   * A row was edited (`message`) or deleted: its line follows in every call row of this PC that names it – open or ended –
   * with the new text, or out. A deleted open call row ends that call here: nothing is left to write.
   */
  private follow(conversationId: string, messageId: string, message?: Message): void {
    for (const call of [...this.calls.values()]) {
      if (!message && call.rowId === messageId) { this.calls.delete(call.id); call.off(); this.remember(call.rowId, false); }
    }
    const s = this.s;
    const rows = quiet(() => s.db.all<{ id: string }>(LISTING, [conversationId, JSON.stringify(messageId)]), []);
    if (!rows.length) return;
    const pc = thisPc(s);
    const text = message ? lineText(message) : undefined;
    for (const { id } of rows) {
      this.write(id, (record) => {
        const at = record.pc === pc ? record.lines.findIndex((line) => line.messageId === messageId) : -1;
        if (at < 0 || record.lines[at].text === text) return record;
        return { ...record, lines: text ? record.lines.map((line, index) => (index === at ? { ...line, text } : line)) : record.lines.filter((_, index) => index !== at) };
      });
    }
  }

  /** Changes a call row's record; the row is saved and announced (it syncs) when it changed. False without such a row. */
  private write(rowId: string, change: (record: CallRecord) => CallRecord): boolean {
    const s = this.s;
    try {
      const row = s.chats.message(rowId);
      const record = row ? callRecord(row) : undefined;
      if (!row || !record) return false;
      const next = change(record);
      if (next === record) return true;
      const updated: Message = { ...row, meta: { ...row.meta, call: next } };
      new MessageRepo(s.db).update(updated);
      s.bus.emit('message.updated', updated);
      return true;
    } catch (error) {
      s.log.warn('call row not written', { rowId, error: String(error) });
      return false;
    }
  }
}
