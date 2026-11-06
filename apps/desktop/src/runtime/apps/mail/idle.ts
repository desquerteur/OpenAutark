// B-053 track D (N5): new mail wakes an agent without polling. One extra IMAP connection holds IDLE (RFC 2177) on
// INBOX (EXAMINE: read-only); the server pushes EXISTS when mail arrives, the watcher leaves IDLE, reads the newest
// envelope and calls target.onNewMail({count, from, subject}). IDLE is renewed every 25 minutes (servers end it
// after 30 – a protocol keepalive, not a check for mail). A dropped connection is opened again with backoff
// (1 min doubling to 30 min; a refused login waits 30 min). A server without IDLE gets no watcher at all.
// B-059: a high-water mark (UIDVALIDITY + the next unhandled UID, kept through target.mark – the app record – and in
// memory) makes each new message count exactly once: after EXAMINE, UIDs at or above the mark are mail that came while
// the watcher was away (sleep, restart, offline) and are reported once; the first connect or a new UIDVALIDITY only
// sets the mark (old mail never wakes). A report reads the new UIDs (UID SEARCH from the mark), fetches FLAGS and the
// headers loops.ts needs for the newest CHECK_MAX, leaves out automatic / bulk mail (auto-replies, newsletters, bounces,
// no-reply senders) and mail already \Seen (read elsewhere meanwhile – on the phone during the night: handled) and only
// then moves the mark past them: only a report with real, unread mail calls onNewMail. A failed
// header read wakes anyway (fail open: a lost mail is worse than a wake without details); a connection that dropped
// meanwhile leaves the mark where it was, so the reconnect reports those mails.
// Owns: that connection, its timers and the mark's use. Never: polls, logs a message, or keeps the password.

import type { MailMark, MailTarget } from '../types.ts';
import { ImapClient, type ImapResult } from './imap.ts';
import { decodeWords } from './mime-text.ts';
import { fetchMap, flagsOf, parseEnvelope, str, type Envelope, type ImapValue, type Untagged } from './imap-parse.ts';
import { parseMessage } from './mime.ts';
import { AUTOMATIC_HEADERS, automaticMail } from './loops.ts';
import type { MailSockets } from './socket.ts';
import { ReconnectNeeded } from '../types.ts';

export const REIDLE_MS = 25 * 60_000;
export const BACKOFF_MIN_MS = 60_000;
export const BACKOFF_MAX_MS = 30 * 60_000;
/** New messages whose headers one report reads (the newest; older ones beyond count as real mail). */
export const CHECK_MAX = 50;
const ITEMS = `UID FLAGS ENVELOPE BODY.PEEK[HEADER.FIELDS (${AUTOMATIC_HEADERS.join(' ')})]`;

type NewMail = { count: number; from?: string; subject?: string };

/** A response code's number ("UIDNEXT 42"), from the tagged line or an untagged OK. */
function codeNumber(result: ImapResult, name: string): number | undefined {
  for (const code of [result.code, ...result.untagged.map((u) => u.code)]) {
    const m = new RegExp(`^${name} (\\d{1,10})\\b`, 'i').exec(code ?? '');
    if (m) return Number(m[1]);
  }
  return undefined;
}

const validMark = (m: MailMark | undefined): MailMark | undefined =>
  m && Number.isInteger(m.validity) && m.validity > 0 && Number.isInteger(m.next) && m.next > 0 ? m : undefined;

/** The header block of a FETCH row (BODY[HEADER.FIELDS …]) as a header map; empty when it is missing. */
function headersOf(row: Map<string, ImapValue>): Map<string, string[]> {
  for (const [key, value] of row) {
    if (!key.startsWith('BODY[HEADER')) continue;
    const raw = Buffer.isBuffer(value) ? value : Buffer.from(str(value) ?? '', 'utf8');
    return parseMessage(Buffer.concat([raw, Buffer.from('\r\n\r\n')])).headers;
  }
  return new Map();
}

export interface WatcherOptions { sockets?: MailSockets; timeoutMs?: number; reidleMs?: number; backoffMinMs?: number; backoffMaxMs?: number }
export type WatcherState = 'starting' | 'idle' | 'waiting' | 'unsupported' | 'closed';

export class NewMailWatcher {
  state: WatcherState = 'starting';
  private client: ImapClient | undefined;
  private exists = 0;
  private grown = 0;
  /** B-059: the mark in memory (also covers a target without `mark`) and the session's UIDVALIDITY. */
  private seen: MailMark | undefined;
  private validity: number | undefined;
  private wake: (() => void) | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private backoff: number;

  private readonly target: MailTarget;
  private readonly opts: WatcherOptions;

  constructor(target: MailTarget, opts: WatcherOptions = {}) {
    this.target = target;
    this.opts = opts;
    this.backoff = opts.backoffMinMs ?? BACKOFF_MIN_MS;
  }

  start(): void { void this.cycle(); }

  close(): void {
    this.state = 'closed';
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    this.signal();
    const client = this.client;
    this.client = undefined;
    client?.destroy();
  }

  /** A getter, so a check after an await is not narrowed away. */
  private get closed(): boolean { return this.state === 'closed'; }

  private signal(): void { const w = this.wake; this.wake = undefined; w?.(); }

  private untagged(r: Untagged): void {
    if (r.type === 'EXISTS' && r.num !== undefined) {
      if (r.num > this.exists) this.grown += r.num - this.exists;
      this.exists = r.num;
      if (this.grown > 0) this.signal();
    } else if (r.type === 'EXPUNGE') {
      this.exists = Math.max(0, this.exists - 1);
    }
  }

  private async cycle(): Promise<void> {
    if (this.closed) return;
    let refused = false;
    try {
      await this.session();
    } catch (error) {
      refused = error instanceof ReconnectNeeded;
    }
    this.client?.destroy();
    this.client = undefined;
    if (this.closed || this.state === 'unsupported') return;
    this.state = 'waiting';
    const max = this.opts.backoffMaxMs ?? BACKOFF_MAX_MS;
    const wait = refused ? max : this.backoff;
    this.backoff = Math.min(max, this.backoff * 2);
    this.retry = setTimeout(() => { this.retry = undefined; void this.cycle(); }, wait);
    this.retry.unref?.();
  }

  private async session(): Promise<void> {
    const client = await ImapClient.open(this.target.imap, {
      sockets: this.opts.sockets, timeoutMs: this.opts.timeoutMs,
      onUntagged: (r) => this.untagged(r), onClose: () => this.signal(),
    });
    this.client = client;
    if (this.closed) { client.destroy(); return; }
    const { user, password } = await this.target.login();
    await client.login(user, password);
    if (!client.has('IDLE')) { this.state = 'unsupported'; await client.logout(); return; }
    this.grown = 0;
    this.exists = 0;
    const examined = await client.command(['EXAMINE INBOX']);
    // What EXAMINE reported is the starting count, not new mail – only UIDs above the mark are (B-059 catch-up).
    this.grown = this.catchUp(codeNumber(examined, 'UIDVALIDITY'), codeNumber(examined, 'UIDNEXT'));
    this.backoff = this.opts.backoffMinMs ?? BACKOFF_MIN_MS;
    while (!this.closed && client.isOpen) {
      const idle = await client.idle();
      this.state = 'idle';
      const woke = new Promise<void>((resolve) => { this.wake = resolve; });
      const renew = setTimeout(() => this.signal(), this.opts.reidleMs ?? REIDLE_MS);
      renew.unref?.();
      if (this.grown > 0) this.signal(); // mail that came between two IDLEs
      await Promise.race([woke, idle.ended]);
      clearTimeout(renew);
      this.wake = undefined;
      if (this.closed || !client.isOpen) break;
      await idle.stop();
      if (this.grown > 0) await this.report(client);
    }
    if (!this.closed) throw new Error('dropped');
  }

  /** The stored mark, else the one in memory (a target mark that fails to read counts as none). */
  private mark(): MailMark | undefined {
    let stored: MailMark | undefined;
    try { stored = validMark(this.target.mark?.get()); } catch { stored = undefined; }
    return this.seen ?? stored;
  }

  private save(mark: MailMark): void {
    this.seen = mark;
    try { this.target.mark?.set(mark); } catch { /* memory still holds it */ }
  }

  /** After EXAMINE: how many UIDs came since the mark; the first connect or a new UIDVALIDITY only sets the mark. */
  private catchUp(validity: number | undefined, next: number | undefined): number {
    this.validity = validity;
    if (!validity || !next) return 0;
    const mark = this.mark();
    if (mark?.validity === validity) return Math.max(0, next - mark.next);
    this.save({ validity, next });
    return 0;
  }

  private async report(client: ImapClient): Promise<void> {
    const grown = this.grown;
    this.grown = 0;
    let found: { info: NewMail; next?: number } | undefined;
    try {
      found = await this.newMail(client, grown);
    } catch (error) {
      if (!client.isOpen) throw error; // the mark did not move: the reconnect catches up from it
      found = { info: { count: Math.max(1, grown) } }; // fail open: the wake-up matters more than the details
    }
    if (!found) return;
    // The mark moves only once the new mail was looked at (or woken for), so each message is reported exactly once.
    if (found.next !== undefined && this.validity) this.save({ validity: this.validity, next: found.next });
    if (found.info.count <= 0) return;
    try { this.target.onNewMail?.(found.info); } catch { /* listener errors stay there */ }
  }

  /** The new messages (UIDs from the mark; without one the newest `grown`), automatic and bulk mail left out, and
   *  the mark past them. A failed header read with the connection still open wakes for all of them (fail open). */
  private async newMail(client: ImapClient, grown: number): Promise<{ info: NewMail; next?: number } | undefined> {
    const mark = this.mark();
    let total: number;
    let asked: number;
    let fetch: string;
    let next: number | undefined;
    if (mark && mark.validity === this.validity) {
      const found = await client.command([`UID SEARCH UID ${mark.next}:*`]);
      const uids: number[] = [];
      for (const u of found.untagged) if (u.type === 'SEARCH') for (const v of u.values) { const n = Number(str(v)); if (Number.isInteger(n) && n >= mark.next) uids.push(n); }
      if (!uids.length) return undefined; // "n:*" also names the newest message when nothing is newer
      uids.sort((a, b) => a - b);
      next = uids[uids.length - 1] + 1;
      total = uids.length;
      const checked = uids.slice(-CHECK_MAX);
      asked = checked.length;
      fetch = `UID FETCH ${checked.join(',')} (${ITEMS})`;
    } else {
      if (this.exists <= 0 || grown <= 0) return undefined;
      const first = Math.max(1, this.exists - Math.min(grown, CHECK_MAX) + 1);
      total = grown;
      asked = this.exists - first + 1;
      fetch = `FETCH ${first}:${this.exists} (${ITEMS})`;
    }
    let rows: Untagged[];
    try {
      rows = (await client.command([fetch])).untagged.filter((u) => u.type === 'FETCH').sort((a, b) => (a.num ?? 0) - (b.num ?? 0));
    } catch (error) {
      if (!client.isOpen) throw error;
      return { info: { count: Math.max(1, total) }, next };
    }
    let count = Math.max(0, total - asked); // older than the newest CHECK_MAX: counted as real mail (gone meanwhile: not at all)
    let newest: Envelope | undefined;
    for (const u of rows) {
      const row = fetchMap(u.values);
      if (flagsOf(row.get('FLAGS')).some((f) => f.toUpperCase() === '\\SEEN')) continue; // read elsewhere: handled
      const env = parseEnvelope(row.get('ENVELOPE'));
      if (automaticMail(headersOf(row), env.from[0]?.address)) continue;
      count += 1;
      newest = env;
    }
    const sender = newest?.from[0];
    const from = sender ? (sender.name ? `${decodeWords(sender.name)} <${sender.address}>` : sender.address) : undefined;
    const subject = newest?.subject !== undefined ? decodeWords(newest.subject).slice(0, 200) : undefined;
    return { info: { count, ...(from ? { from } : {}), ...(subject !== undefined ? { subject } : {}) }, next };
  }
}
