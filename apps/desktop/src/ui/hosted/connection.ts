// The iPhone web app's link to the company (B-078 follow-up, as Android's relay/PhoneConnection.java): one meeting-server
// connection with every PC this phone knows pinned, and one encrypted channel to the first of them that is online, with
// the stream mux on it. The page holds all of it while it is visible (iOS gives a service worker no long-lived socket).
// It reconnects with backoff (1, 2, 5, 15, 30, 60 s; one-shot timers, no polling) after the meeting server or the PC went
// away and right away when a pinned PC comes online. nudge() on resume (visible, pageshow, online, a push's 'wf.wake'):
// after more than 15 s hidden, or with no live connection, it dials again; otherwise one probe (3 s) checks the
// connection, since JavaScript sees no pings. After each connect, phone.pcs (bearer POST /rpc) lists my PCs; the pins
// grow with it (an older PC without that method: the one PC stays); a 401/403 there is `refused` (removed on the PC).
// A removed phone hears nothing at all (the PC unpins it, so no PC is ever online for it): after 60 s with the meeting
// server answering and no channel, `unanswered` tells the shell, which offers Forget.
// Owns: connecting, reconnecting, the pins and the current mux. Never: stores anything itself (the shell does), polls the
// PC, or talks to a PC it does not pin.

import type { PhonePc } from '../../shared/api/methods-phone.ts';
import { fromB64url, fromUtf8, utf8, type Bytes } from './bytes.ts';
import { connectChannel, type SecureChannel } from './channel.ts';
import { fingerprint } from './crypto.ts';
import { headerOf, httpFetch } from './http.ts';
import { RelayLink, type WsFactory } from './relay.ts';
import type { Saved } from './store.ts';
import { StreamMux } from './streams.ts';

export const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];
const HIDDEN_REDIAL_MS = 15_000;
/** A channel that ends sooner than this counts as a failure (backoff, not an instant redial). */
const SHORT_LIVED_MS = 5_000;

export interface ConnectionOptions {
  saved: Saved;
  socket?: WsFactory;
  status?(text: string, connected: boolean): void;
  /** phone.pcs changed the list (the shell stores it). */
  pcsChanged?(pcs: PhonePc[]): void;
  /** The PC refused this phone's token (403: removed). */
  refused?(): void;
  /**
   * true once the meeting server answers but no pinned PC gave a channel for `unansweredMs` (removed there, or every PC
   * off); false when a channel comes up again.
   */
  unanswered?(unanswered: boolean): void;
  unansweredMs?: number;
  now?(): number;
}

export const UNANSWERED_MS = 60_000;
export const UNANSWERED_TEXT = 'Your PCs don’t answer this phone. It may have been removed there.';

export class Connection {
  private readonly options: ConnectionOptions;
  private saved: Saved;
  private link: RelayLink | undefined;
  private channel: SecureChannel | undefined;
  private current: StreamMux | undefined;
  private pcFp: string | undefined;
  private openedAt = 0;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private again = false;
  private stopped = true;
  private readonly waiters = new Set<() => void>();
  private lastStatus = '';
  private unansweredTimer: ReturnType<typeof setTimeout> | undefined;
  private unansweredSaid = false;

  constructor(options: ConnectionOptions) {
    this.options = options;
    this.saved = options.saved;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.unansweredTimer) clearTimeout(this.unansweredTimer);
    this.unansweredTimer = undefined;
    this.channel?.close();
    this.link?.close();
    this.link = undefined;
    for (const wake of [...this.waiters]) wake();
  }

  /** The current mux, or undefined. */
  get mux(): StreamMux | undefined { return this.current && !this.current.closed ? this.current : undefined; }

  /** The PC the channel goes to now. */
  get pc(): string | undefined { return this.mux ? this.pcFp : undefined; }

  get pcs(): PhonePc[] { return this.saved.pcs; }

  /** The mux once a channel is up, within `ms` (undefined when none came). Starts a try at once. */
  awaitMux(ms: number): Promise<StreamMux | undefined> {
    const now = this.mux;
    if (now || this.stopped) return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = () => { clearTimeout(limit); this.waiters.delete(done); resolve(this.mux); };
      const limit = setTimeout(done, ms);
      this.waiters.add(done);
      this.kick();
    });
  }

  /** The page came back: redial after a long pause or a dead connection, else probe the one there is. */
  nudge(hiddenMs = 0): void {
    if (this.stopped) return;
    this.attempt = 0;
    if (hiddenMs > HIDDEN_REDIAL_MS || !this.link?.isUp()) { this.drop(); this.kick(); return; }
    const link = this.link;
    void link.probe(3_000).then((alive) => {
      if (link !== this.link) return;
      if (!alive) this.drop();
      this.kick();
    });
  }

  /** Runs one connect step now (a waiting backoff timer is cancelled). */
  kick(): void {
    if (this.stopped) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.running) { this.again = true; return; }
    void this.run();
  }

  private drop(): void {
    this.channel?.close();
    this.link?.close();
    this.link = undefined;
  }

  private schedule(): void {
    if (this.stopped || this.timer) return;
    const delay = BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)];
    this.timer = setTimeout(() => { this.timer = undefined; void this.run(); }, delay);
  }

  private say(text: string, connected: boolean): void {
    if (text === this.lastStatus) return;
    this.lastStatus = text;
    this.options.status?.(text, connected);
  }

  /** The meeting server answers, no PC does: one one-shot timer from the first such try (no polling). */
  private noAnswer(): void {
    if (this.stopped || this.unansweredTimer || this.unansweredSaid) return;
    this.unansweredTimer = setTimeout(() => {
      this.unansweredTimer = undefined;
      if (this.stopped || this.mux || !this.link?.isUp()) return; // the next try without an answer starts it again
      this.unansweredSaid = true;
      this.say(UNANSWERED_TEXT, false);
      this.options.unanswered?.(true);
    }, this.options.unansweredMs ?? UNANSWERED_MS);
  }

  private answered(): void {
    if (this.unansweredTimer) clearTimeout(this.unansweredTimer);
    this.unansweredTimer = undefined;
    if (!this.unansweredSaid) return;
    this.unansweredSaid = false;
    this.options.unanswered?.(false);
  }

  private nameOf(fp: string): string { return this.saved.pcs.find((pc) => pc.fingerprint === fp)?.name ?? 'your PC'; }

  private pins(): Map<string, Bytes> {
    return new Map(this.saved.pcs.map((pc) => [pc.fingerprint, fromB64url(pc.publicKey)]));
  }

  private async run(): Promise<void> {
    if (this.stopped) return;
    this.running = true;
    try {
      if (!this.link?.isUp()) {
        this.say('Reaching the meeting server…', false);
        const link = new RelayLink({
          key: this.saved.key, pins: this.pins(), socket: this.options.socket,
          events: {
            presence: (_fp, online) => { if (online && link === this.link) this.kick(); },
            down: () => { if (link === this.link) { this.link = undefined; this.schedule(); } },
          },
        });
        this.link = link;
        await link.connect(this.saved.relay);
      }
      if (this.mux) return;
      const link = this.link;
      const fp = link?.firstOnline();
      if (!link || !fp) {
        this.say(this.unansweredSaid ? UNANSWERED_TEXT : 'None of your PCs is online. Autark must be running on one of them.', false);
        this.noAnswer();
        return;
      }
      this.say(`Connecting to ${this.nameOf(fp)}…`, false);
      const pc = this.saved.pcs.find((row) => row.fingerprint === fp)!;
      const tunnel = await link.open(fp);
      const channel = await connectChannel(tunnel, { key: this.saved.key, deviceId: this.saved.deviceId }, fromB64url(pc.publicKey));
      const mux = new StreamMux(channel);
      this.channel = channel;
      this.current = mux;
      this.pcFp = fp;
      this.openedAt = (this.options.now ?? Date.now)();
      channel.onClose(() => {
        if (this.channel !== channel) return;
        this.channel = undefined;
        this.current = undefined;
        this.say(`Lost the connection to ${this.nameOf(fp)}.`, false);
        if ((this.options.now ?? Date.now)() - this.openedAt < SHORT_LIVED_MS) this.schedule();
        else { this.attempt = 0; this.kick(); }
      });
      if (channel.closed) throw new Error('Your PC closed the connection.');
      this.say(`Connected to ${this.nameOf(fp)}.`, true);
      this.answered();
      for (const wake of [...this.waiters]) wake();
      void this.refreshPcs(mux);
    } catch (error) {
      if (this.stopped) return;
      this.say(error instanceof Error ? error.message : 'The connection failed.', false);
      if (this.link?.isUp()) this.noAnswer(); // a channel the PC refused or never opened
      this.schedule();
    } finally {
      this.running = false;
      if (this.again) { this.again = false; this.kick(); }
    }
  }

  /** phone.pcs: my PCs with their keys (each key checked against its fingerprint); new ones get pinned. */
  async refreshPcs(mux: StreamMux): Promise<void> {
    try {
      const { head, body } = await httpFetch(mux, {
        method: 'POST', path: '/rpc',
        headers: [['Authorization', `Bearer ${this.saved.token}`], ['Content-Type', 'application/json'], ['X-Workforce-Protocol', '1']],
        body: utf8(JSON.stringify({ id: 1, method: 'phone.pcs' })),
      });
      if (head.status === 403 || head.status === 401) { this.options.refused?.(); return; }
      if (!/json/.test(headerOf(head, 'content-type') ?? '')) return;
      const reply = JSON.parse(fromUtf8(body)) as { result?: { pcs?: unknown } };
      const rows = Array.isArray(reply.result?.pcs) ? reply.result.pcs as PhonePc[] : [];
      const next: PhonePc[] = [];
      for (const row of rows.slice(0, 16)) {
        if (!row || typeof row.publicKey !== 'string' || typeof row.fingerprint !== 'string' || typeof row.name !== 'string') continue;
        try { if ((await fingerprint(fromB64url(row.publicKey))) !== row.fingerprint) continue; } catch { continue; }
        next.push({ deviceId: String(row.deviceId ?? ''), name: row.name, fingerprint: row.fingerprint, publicKey: row.publicKey });
      }
      if (!next.length) return; // an older PC (no phone.pcs) or nothing new: keep the list
      if (this.pcFp && !next.some((pc) => pc.fingerprint === this.pcFp)) {
        const reached = this.saved.pcs.find((pc) => pc.fingerprint === this.pcFp);
        if (reached) next.unshift(reached);
      }
      if (JSON.stringify(next) === JSON.stringify(this.saved.pcs)) return;
      this.saved = { ...this.saved, pcs: next };
      this.link?.setPins(this.pins());
      this.options.pcsChanged?.(next);
    } catch { /* the next connect asks again */ }
  }
}
