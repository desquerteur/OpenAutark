// DeviceService implementation: the linked PCs. Every PC is home of its own data; linked PCs are peers, and each one
// keeps one live connection (pinned-key handshake + encrypted channel, channel.ts).
// Owns: storing a proven PC (`add`, after the connect flow of remote/* or the roster), peer connections (one per linked
// PC), their status, forwarding calls (dialing on demand), the exchange of addresses, the method registry, rename/revoke.
// Dialing (devices/reach.ts): the stored addresses and the address the meeting server saw are opened at once, a tunnel
// through the meeting server is the last fallback (`setMeeting`). `reconnect()` dials every linked PC without a live link
// and pings each live one once (start, host resume/online, the peer listener opened). Only the side with the smaller
// deviceId retries with backoff after a close or failed dial – not after a refusal (the other PC unlinked this one: close
// code 4003). If both sides dial at once, the smaller id's link stays. B-077: both ends ping every 15 s (keepalive.ts), the
// backoff stops at 30 s; dialed links, closes and refusals are info lines.
// Addresses: when a link comes up, and whenever this PC's own addresses change, each PC sends its addresses
// (`device.addresses`); the receiver keeps that list plus one older address. Link kinds (sync/home.ts): a PC that joined
// as an employee (`personId`) reaches only methods registered for 'employee' (ping, caps, addresses, sync.rows – only its
// person's own lines and task changes, sync/employee.ts – and what any module opens with `register(m, h, kinds)`, e.g.
// device.sibling, calendar.ask); my own PCs and an employer reach every other method.
// Never: links a PC without a finished connect flow, polls (timers are backoff retries and the one-shot ping timeout of
// a trigger), or executes tools itself (handlers are injected).

import type { Bus } from '../bus.ts';
import type { Clock, DeviceService, Logger } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { Device, DeviceCaps } from '../../shared/model/devices.ts';
import { acceptSecure, type SocketLike } from './channel.ts';
import type { DeviceIdentity } from './identity.ts';
import { b64url, fingerprintOf, fromB64url } from './keys.ts';
import { validAddress, type PeerInfo } from './pair-proof.ts';
import { DevicesRepo, publicDevice, type DeviceRecord } from './repo.ts';
import { MAX_ADDRESSES, mergeAddresses, openChannel, firstOpen, seenText, type MeshMeeting } from './reach.ts';
import type { Timers } from '../schedules/scheduler.ts';
import { RpcPeer, type PeerHandler } from './rpc-peer.ts';

export type { Timers };

const realTimers: Timers = {
  set: (fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface MeshDeps {
  db: Db;
  identity: DeviceIdentity;
  clock: Clock;
  log: Logger;
  bus: Bus;
  /** Opens a WebSocket to a peer runtime at its base URL (compose/peer-dial.ts maps it to ws(s)://…/peer). */
  dial(address: string): Promise<SocketLike>;
  timers?: Timers;
}

export const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];
/** Two links attached this close together count as simultaneous dials (tie-break below). */
const RACE_MS = 10_000;
/** A live link that does not answer a trigger's ping within this time is closed and redialed. */
const PROBE_MS = 5_000;
export const ADDRESSES_METHOD = 'device.addresses';
/** Which links reach a method: 'ceo' (my own PCs), 'employee' (a PC that joined here as an employee), 'employer'. */
export type LinkKind = 'ceo' | 'employee' | 'employer';
export const EVERY_LINK: readonly LinkKind[] = ['ceo', 'employee', 'employer'];
const kindOf = (record: DeviceRecord | undefined): LinkKind => (record?.personId ? 'employee' : record?.joinedAs === 'employee' ? 'employer' : 'ceo');

interface Link { peer: RpcPeer; dialer: string; at: number; probing?: boolean }

/** Nothing was sent: the device is unknown, revoked, or the mesh is closed. */
const notLinked = (deviceId: string) => new WorkforceError('not_found', 'This device is not linked.', { details: { deviceId, reachable: false } });
/** Stopped before anything was sent (reachable: false → a plain failure, not an unknown effect). */
const cancelled = (deviceId: string) => new WorkforceError('cancelled', 'Cancelled.', { details: { deviceId, reachable: false } });

export class DeviceMesh implements DeviceService {
  private readonly deps: MeshDeps;
  private readonly repo: DevicesRepo;
  private readonly timers: Timers;
  private links = new Map<string, Link>();
  private dialing = new Map<string, Promise<RpcPeer>>();
  private retry = new Map<string, { attempt: number; handle?: unknown }>();
  /** Linked PCs whose last dial failed or whose link closed (status 'offline'). */
  private unreachable = new Set<string>();
  private handlers = new Map<string, { handler: PeerHandler; kinds: ReadonlySet<LinkKind> }>();
  private meeting?: MeshMeeting;
  private ownAddresses = '';
  private closed = false;

  constructor(deps: MeshDeps) {
    this.deps = deps;
    this.repo = new DevicesRepo(deps.db);
    this.timers = deps.timers ?? realTimers;
    this.register('ping', async () => ({ ok: true, at: deps.clock.now() }), EVERY_LINK);
    this.register('device.caps', async () => this.self().caps, EVERY_LINK);
    this.register(ADDRESSES_METHOD, async (params, from) => this.received(params, from), EVERY_LINK);
  }

  // ---------------------------------------------------------------- DeviceService

  self(): Device {
    return publicDevice(this.repo.get(this.deps.identity.deviceId)!);
  }

  list(): Device[] {
    return this.repo.list().map((record) => this.view(record));
  }

  online(deviceId: string): boolean {
    if (deviceId === this.deps.identity.deviceId) return true;
    const link = this.links.get(deviceId);
    return Boolean(link && !link.peer.channel.closed);
  }

  /** Runs `method` on a device; a linked PC without a live link is dialed first. A stop during the dial sends nothing. */
  async call(deviceId: string, method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (deviceId === this.deps.identity.deviceId) {
      const entry = this.handlers.get(method);
      if (!entry) throw new WorkforceError('not_found', `Unknown device method ${method}.`);
      return entry.handler(params, deviceId, signal ?? new AbortController().signal);
    }
    const peer = await this.connectUntil(deviceId, signal);
    if (signal?.aborted) throw cancelled(deviceId);
    return peer.call(method, params, { signal, ...(method === 'tools.call' ? { timeoutMs: 2 ** 31 - 1 } : {}) }); // a tool's own limits and the turn's stop bound it
  }

  // ---------------------------------------------------------------- management

  /** The one extension point for peer methods of any module; `kinds`: the links that reach it (EVERY_LINK: employees' PCs too). */
  register(method: string, handler: PeerHandler, kinds: readonly LinkKind[] = ['ceo', 'employer']): void {
    this.handlers.set(method, { handler, kinds: new Set(kinds) });
  }

  /** The meeting server's extra ways in (undefined: none). */
  setMeeting(meeting: MeshMeeting | undefined): void { this.meeting = meeting; }

  /** This PC's identity as the connect flow presents it. */
  selfInfo(): PeerInfo {
    const self = this.repo.get(this.deps.identity.deviceId)!;
    return { id: self.id, name: self.name, role: 'home', pub: b64url(this.deps.identity.publicKey), addresses: self.addresses.filter(validAddress).slice(0, MAX_ADDRESSES) };
  }

  /**
   * Stores a PC the connect flow proved (remote/*) and connects: the requester ('joiner') dials at
   * once, the accepting side waits for that dial and retries after the first backoff step.
   * A device id with another key is never that PC, and a key another device holds never a second one: refused, nothing changes.
   */
  add(info: PeerInfo, options: { side: 'joiner' | 'inviter'; personId?: string; joinedAs?: 'ceo' | 'employee' }): Device {
    if (info.id === this.deps.identity.deviceId) throw new WorkforceError('bad_request', 'A device cannot link with itself.');
    const existing = this.repo.get(info.id);
    const active = existing && !existing.revokedAt && existing.status !== 'revoked';
    if (active && (existing.kind !== 'pc' || existing.publicKey !== info.pub)) {
      throw new WorkforceError('forbidden', 'This device id already belongs to a linked device with another key. Remove that device first.');
    }
    const holder = this.repo.byFingerprint(fingerprintOf(fromB64url(info.pub))); // one key, one device (mine included)
    if (holder && holder.id !== info.id) throw new WorkforceError('forbidden', 'This key already belongs to another device.');
    const now = this.deps.clock.now();
    const record = this.repo.upsert({
      id: info.id, name: info.name, kind: 'pc', role: 'home', fingerprint: fingerprintOf(fromB64url(info.pub)), publicKey: info.pub,
      addresses: info.addresses, caps: active ? existing.caps : {}, status: 'offline', self: false, pairedAt: now, lastSeenAt: now,
      ...(options.personId ? { personId: options.personId } : {}), ...(options.joinedAs ? { joinedAs: options.joinedAs } : {}),
    });
    this.emit(record.id);
    this.linked(record.id, options.side);
    return this.view(record);
  }

  /** Updates this device's advertised addresses/caps/name; new addresses go to every online PC. */
  updateSelf(patch: { addresses?: string[]; caps?: DeviceCaps; name?: string }): Device {
    const current = this.repo.get(this.deps.identity.deviceId)!;
    const next = this.repo.patch(current.id, {
      addresses: patch.addresses ?? current.addresses,
      caps: patch.caps ? { ...current.caps, ...patch.caps } : current.caps,
      name: patch.name ?? current.name,
    })!;
    this.deps.bus.emit('device.upserted', publicDevice(next));
    const own = JSON.stringify(next.addresses);
    if (own !== this.ownAddresses) {
      this.ownAddresses = own;
      for (const id of this.links.keys()) if (this.online(id)) this.sendAddresses(id);
    }
    return publicDevice(next);
  }

  rename(id: string, name: string): Device {
    const clean = name.trim().slice(0, 60);
    if (!clean) throw new WorkforceError('bad_request', 'Name is empty.');
    const next = this.repo.patch(id, { name: clean });
    if (!next) throw new WorkforceError('not_found', 'Device not found.');
    this.deps.bus.emit('device.upserted', this.view(next));
    return this.view(next);
  }

  revoke(id: string): void {
    if (id === this.deps.identity.deviceId) throw new WorkforceError('bad_request', 'This device cannot remove itself.');
    const next = this.repo.patch(id, { status: 'revoked', revokedAt: this.deps.clock.now() });
    if (!next) throw new WorkforceError('not_found', 'Device not found.');
    this.cancelRetry(id);
    const link = this.links.get(id);
    this.links.delete(id);
    this.unreachable.delete(id);
    link?.peer.channel.close();
    this.deps.bus.emit('device.upserted', publicDevice(next));
  }

  /** Called once at startup, after the peer listener is up: connects every linked PC. */
  start(): void { this.reconnect(); }

  /** Dials every linked PC without a live link and pings every live one once (event-driven, never a timer). */
  reconnect(): void {
    if (this.closed) return;
    for (const record of this.repo.list({ kinds: ['pc'] })) {
      if (!this.linkable(record)) continue;
      const link = this.links.get(record.id);
      if (link && !link.peer.channel.closed) this.probe(record.id, link);
      else this.redial(record.id);
    }
  }

  /** A PC was just added: the joiner dials at once; the inviter waits for that dial and retries after the first step. */
  linked(deviceId: string, side: 'joiner' | 'inviter'): void {
    if (this.closed || this.online(deviceId)) return;
    this.unreachable.delete(deviceId);
    this.cancelRetry(deviceId);
    if (side === 'joiner') { void this.connect(deviceId).catch(() => undefined); return; }
    this.emit(deviceId); // connecting
    this.scheduleRetry(deviceId);
  }

  close(): void {
    this.closed = true;
    for (const id of [...this.retry.keys()]) this.cancelRetry(id);
    for (const link of this.links.values()) link.peer.channel.close();
    this.links.clear();
  }

  // ---------------------------------------------------------------- connections

  /** Server side of `/peer` (the HTTP server, the peer listener or a meeting-server tunnel). */
  async accept(socket: SocketLike): Promise<string> {
    const channel = await acceptSecure(socket, this.signer(), (peerPub) => {
      const record = this.repo.byFingerprint(fingerprintOf(peerPub));
      return record && this.linkable(record) && record.publicKey === b64url(peerPub) ? record.id : undefined;
    });
    this.attach(channel.peerId, this.peerOf(channel.peerId, channel), channel.peerId);
    return channel.peerId;
  }

  /** Returns a live connection to a linked PC, dialing it if needed. */
  connect(deviceId: string): Promise<RpcPeer> {
    const live = this.links.get(deviceId);
    if (live && !live.peer.channel.closed) return Promise.resolve(live.peer);
    const inflight = this.dialing.get(deviceId);
    if (inflight) return inflight;
    const record = this.repo.get(deviceId);
    if (this.closed || !record || !this.linkable(record)) return Promise.reject(notLinked(deviceId));
    const attempt = this.dial(record).then(
      (peer) => { this.dialing.delete(deviceId); return peer; },
      (error: unknown) => {
        this.dialing.delete(deviceId);
        if (error instanceof WorkforceError && error.code === 'unavailable') {
          this.unreachable.add(deviceId);
          this.emit(deviceId);
          if (error.details?.refused) this.cancelRetry(deviceId); // the other PC unlinked this one
          else this.scheduleRetry(deviceId);
        }
        throw error;
      },
    );
    this.dialing.set(deviceId, attempt);
    this.emit(deviceId); // connecting
    return attempt;
  }

  private connectUntil(deviceId: string, signal?: AbortSignal): Promise<RpcPeer> {
    if (!signal) return this.connect(deviceId);
    if (signal.aborted) return Promise.reject(cancelled(deviceId));
    return new Promise((resolve, reject) => {
      const stop = () => reject(cancelled(deviceId));
      signal.addEventListener('abort', stop, { once: true });
      void this.connect(deviceId).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    });
  }

  /**
   * Direct first: every stored and meeting-seen address is opened at once and the first socket that
   * opens runs the handshake; else a tunnel through the meeting server. `refused`: a socket opened and
   * the other PC closed it before answering the handshake – it does not accept this PC.
   */
  private async dial(record: DeviceRecord): Promise<RpcPeer> {
    const deviceId = record.id;
    const direct = [...new Set([...record.addresses, ...(this.meeting?.addresses(record) ?? [])])].filter(validAddress);
    const routes: Array<() => Promise<SocketLike>> = [];
    if (direct.length) routes.push(() => firstOpen(direct.map((address) => () => this.deps.dial(address))));
    routes.push(() => this.meeting?.tunnel(record) ?? Promise.reject(new Error('not at the meeting server')));
    const result = await openChannel(routes, this.signer(), record.fingerprint);
    if ('channel' in result) {
      const peer = this.attach(deviceId, this.peerOf(deviceId, result.channel), this.deps.identity.deviceId);
      if (peer.channel === result.channel) this.deps.log.info('peer dialed', { deviceId }); // accepted links log 'peer connected' (http/peer.ts)
      return peer;
    }
    const { refused, error } = result;
    // A refusal is rare and ends the retries: worth an info line; a PC that is off fails quietly every 30 s.
    this.deps.log[refused ? 'info' : 'debug']('device dial failed', { deviceId, refused, error: String((error as Error)?.message ?? error) });
    const latest = this.repo.get(deviceId) ?? record;
    const message = `${latest.name} is not reachable (${seenText(latest.lastSeenAt, this.deps.clock.now())}).`;
    throw new WorkforceError('unavailable', message, { details: { deviceId, reachable: false, ...(refused ? { refused } : {}) } });
  }

  /** An RpcPeer for `deviceId`: its link kind reaches the methods registered for that kind. */
  private peerOf(deviceId: string, channel: ConstructorParameters<typeof RpcPeer>[0]): RpcPeer {
    return new RpcPeer(channel, (method) => {
      const entry = this.handlers.get(method);
      const kind = kindOf(this.repo.get(deviceId));
      if (!entry || entry.kinds.has(kind)) return entry?.handler;
      return async () => { throw new WorkforceError('forbidden', kind === 'employee' ? 'An employee\'s PC does not run tools on this PC.' : 'This link does not run that method on this PC.'); };
    });
  }

  private redial(deviceId: string): void {
    this.cancelRetry(deviceId);
    void this.connect(deviceId).catch(() => undefined); // a failure schedules the retry
  }

  /** One ping on a trigger: a link that died while this PC slept still looks open on the dialing side. */
  private probe(deviceId: string, link: Link): void {
    if (link.probing) return;
    link.probing = true;
    let done = false;
    const settle = (alive: boolean) => {
      if (done) return;
      done = true;
      link.probing = false;
      this.timers.clear(handle);
      if (alive || this.closed) return;
      const current = this.links.get(deviceId);
      if (current && current !== link && !current.peer.channel.closed) return; // a newer link is up
      if (!link.peer.channel.closed) link.peer.channel.close();
      this.redial(deviceId);
    };
    const handle = this.timers.set(() => settle(false), PROBE_MS);
    link.peer.call('ping', null, { timeoutMs: PROBE_MS }).then(() => settle(true), () => settle(false));
  }

  /** Makes `peer` the link to `deviceId` and returns the link that stays (see the tie-break). */
  private attach(deviceId: string, peer: RpcPeer, dialer: string): RpcPeer {
    const record = this.repo.get(deviceId);
    if (this.closed || !record || !this.linkable(record)) {
      peer.channel.close();
      throw notLinked(deviceId);
    }
    const now = this.deps.clock.now();
    const current = this.links.get(deviceId);
    if (current && current.peer !== peer && !current.peer.channel.closed) {
      // Both sides dialed at once: each side keeps the link dialed by the smaller id.
      const smaller = this.deps.identity.deviceId < deviceId ? this.deps.identity.deviceId : deviceId;
      if (current.dialer === smaller && dialer !== smaller && now - current.at < RACE_MS) {
        peer.channel.close();
        return current.peer;
      }
      current.peer.channel.close();
    }
    this.links.set(deviceId, { peer, dialer, at: now });
    this.unreachable.delete(deviceId);
    this.cancelRetry(deviceId);
    this.markSeen(deviceId, 'online');
    peer.channel.onClose(() => {
      if (this.links.get(deviceId)?.peer !== peer) return;
      this.links.delete(deviceId);
      this.unreachable.add(deviceId);
      this.markSeen(deviceId, 'offline');
      if (!this.closed) this.deps.log.info('peer link closed', { deviceId, retries: this.keeps(deviceId) });
      this.scheduleRetry(deviceId);
    });
    void peer.call('device.caps', null, { timeoutMs: 10_000 }).then(
      (caps) => { if (caps && typeof caps === 'object') this.repo.patch(deviceId, { caps: caps as DeviceCaps }); },
      () => undefined,
    );
    this.sendAddresses(deviceId);
    return peer;
  }

  /** `device.addresses` from an authenticated linked PC: its own list becomes the truth (plus one older one). */
  private received(params: unknown, from: string): { ok: true } {
    const list = (params as { addresses?: unknown })?.addresses;
    const addresses = Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string' && validAddress(item)).slice(0, MAX_ADDRESSES) : [];
    const record = this.repo.get(from);
    if (!record || !this.linkable(record)) return { ok: true };
    const next = mergeAddresses(addresses, record.addresses);
    if (JSON.stringify(next) !== JSON.stringify(record.addresses)) this.repo.patch(from, { addresses: next });
    return { ok: true };
  }

  private sendAddresses(deviceId: string): void {
    const addresses = this.selfInfo().addresses;
    const peer = this.links.get(deviceId)?.peer;
    void peer?.call(ADDRESSES_METHOD, { addresses }, { timeoutMs: 10_000 }).catch(() => undefined);
  }

  /** A linked PC this mesh connects to: not revoked, not this PC. */
  private linkable(record: DeviceRecord): boolean {
    return record.kind === 'pc' && !record.self && !record.revokedAt && record.status !== 'revoked' && record.status !== 'pairing';
  }

  /** The side with the smaller deviceId keeps the link: it alone retries after a close or failure. */
  private keeps(deviceId: string): boolean {
    if (this.closed || this.deps.identity.deviceId >= deviceId) return false;
    const record = this.repo.get(deviceId);
    return Boolean(record && this.linkable(record));
  }

  private scheduleRetry(deviceId: string): void {
    if (!this.keeps(deviceId)) return;
    const state = this.retry.get(deviceId) ?? { attempt: 0 };
    if (state.handle !== undefined) return;
    const delay = BACKOFF_MS[Math.min(state.attempt, BACKOFF_MS.length - 1)];
    state.handle = this.timers.set(() => {
      state.handle = undefined;
      state.attempt++;
      void this.connect(deviceId).catch(() => undefined); // a failure schedules the next step
    }, delay);
    this.retry.set(deviceId, state);
  }

  private cancelRetry(deviceId: string): void {
    const state = this.retry.get(deviceId);
    if (state?.handle !== undefined) this.timers.clear(state.handle);
    this.retry.delete(deviceId);
  }

  private markSeen(deviceId: string, status: 'online' | 'offline'): void {
    if (this.repo.patch(deviceId, { status, lastSeenAt: this.deps.clock.now() })) this.emit(deviceId);
  }

  private emit(deviceId: string): void {
    const record = this.repo.get(deviceId);
    if (record) this.deps.bus.emit('device.upserted', this.view(record));
  }

  private view(record: DeviceRecord): Device {
    return publicDevice({ ...record, status: this.statusOf(record) });
  }

  private statusOf(record: DeviceRecord): Device['status'] {
    if (record.revokedAt) return 'revoked';
    if (record.self) return 'online';
    if (record.kind !== 'pc') return record.status;
    if (this.online(record.id)) return 'online';
    return this.unreachable.has(record.id) && !this.dialing.has(record.id) ? 'offline' : 'connecting';
  }

  private signer() {
    const identity = this.deps.identity;
    return { deviceId: identity.deviceId, publicKey: identity.publicKey, sign: (data: Uint8Array) => identity.sign(data) };
  }
}
