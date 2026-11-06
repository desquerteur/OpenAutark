// The meeting server (settings.devices.relay; self-hosted services/remote-relay): how linked PCs that
// cannot reach each other directly find each other, and how "Connect" reaches a PC by Remote ID.
// Direct first: the mesh dials the stored addresses together with the address the server saw the
// other PC on (its public IP and peer port – a fixed IP or a forwarded port answers there); only
// when none of them answers does a tunnel through the server carry the unchanged pinned-key peer
// channel. A linked PC coming online at the server is dialed at once (the side with the smaller id;
// an event, no polling). Connect requests to a PC found by Remote ID travel sealed through the
// server (`relay:<fingerprint>` routes); the person on that PC still accepts with the code. A lookup
// while the server is still connecting (a cold start) waits once for it, until its signal ends.
// Presence is only shared between PCs that pinned each other; revoking unpins at once.
// Phone apps paired through the server (rendezvous/phone-pair.ts; B-078: also the ones the roster brings from my other
// PCs) are pinned the same way for as long as their device row exists; their tunnels go to the phone bridge, never into
// the PC mesh. A phone's connect request (role 'phone') takes the same route as a PC's; the old `phone` code message of
// 0.3.x apps gets one line asking for the app update.
// Owns: the mesh hook, the request route, the relay client and its state.
// Never: links a PC, or talks to a server the person did not configure.

import type { Bus } from '../../bus.ts';
import type { Clock, Logger } from '../../contracts.ts';
import type { Db } from '../../db/database.ts';
import type { RelayState } from '../../../shared/model/relay.ts';
import { relayAddress } from '../../../shared/model/relay.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { MEETING_OFF, MEETING_UNREACHABLE, type Found } from '../../remote/find.ts';
import { remoteIdOf } from '../../remote/id.ts';
import type { SocketLike } from '../channel.ts';
import type { DeviceIdentity } from '../identity.ts';
import { fingerprintOf, fromB64url } from '../keys.ts';
import type { DeviceMesh, Timers } from '../mesh.ts';
import { DevicesRepo, type DeviceRecord } from '../repo.ts';
import { relayPhone, type PhoneBridge } from './phone.ts';
import { RelayClient, type RelayClientDeps } from './relay-client.ts';
import type { RelayTunnel } from './tunnel.ts';

/** Pins a device may hold at the server (services/remote-relay MAX_PEERS). */
const MAX_PEERS = 64;
export const RELAY_PREFIX = 'relay:';
const WHO_TIMEOUT_MS = 5_000;
const PHONE_DRAIN_MS = 2_000;
/**
 * The answer to the old preview app's 'phone' op (0.2.x/0.3.2 APKs, package ….android.preview): the release is a new
 * app beside it (another package and key), so it says where that app is and that the preview goes afterwards.
 */
export const PREVIEW_APP = 'This is the old preview app. Install Autark for Android from github.com/teydra/OpenAutark/releases (a new app), pair it with this PC\'s Remote ID, then remove the preview app.';

export type PostOptions = { timeoutMs: number; signal?: AbortSignal };

export interface MeetingDeps {
  db: Db;
  bus: Bus;
  log: Logger;
  clock: Clock;
  identity: Pick<DeviceIdentity, 'deviceId' | 'fingerprint' | 'publicKey' | 'sign'>;
  mesh: Pick<DeviceMesh, 'setMeeting' | 'accept' | 'online' | 'connect'>;
  /** The connect flow: what this PC answers to a sealed request (remote/service.ts). */
  remote: { handle(body: Record<string, unknown>, from: { address?: string }): Promise<unknown>; wellKnown(): { deviceId: string; name: string; fingerprint: string }; kinds: ReadonlySet<string> };
  /** settings.devices.relay (undefined/empty = off). */
  relayUrl(): string | undefined;
  /** This PC accepts connection requests (settings.devices.findable). */
  findable(): boolean;
  /** The peer listener's port while it listens (the server builds this PC's public address from it). */
  port(): number | undefined;
  timers?: Timers;
  socket?: RelayClientDeps['socket'];
  /** Phone apps over the server: their tunnels. */
  phones?: Pick<PhoneBridge, 'accept' | 'closeAll'>;
}

const linkedPc = (record: DeviceRecord | undefined): record is DeviceRecord =>
  Boolean(record && record.kind === 'pc' && !record.self && !record.revokedAt && record.status !== 'revoked' && record.publicKey);

export class Meeting {
  private readonly deps: MeetingDeps;
  private readonly repo: DevicesRepo;
  readonly relay: RelayClient;
  /** Box keys of PCs found by Remote ID (sealed requests go to them). */
  private readonly boxes = new Map<string, string>();
  private offs: Array<() => void> = [];
  private lastState = '';
  /** Phones pinned at the last sync, and removed ones still pinned for PHONE_DRAIN_MS. */
  private phonePins = new Map<string, string>();
  private readonly leaving = new Map<string, string>();
  /** Lookups waiting for the server connection (woken by its state changes). */
  private readonly waiters = new Set<() => void>();

  constructor(deps: MeetingDeps) {
    this.deps = deps;
    this.repo = new DevicesRepo(deps.db);
    this.relay = new RelayClient({
      identity: deps.identity, log: deps.log, timers: deps.timers, socket: deps.socket,
      events: {
        changed: () => this.changed(),
        presence: (fp, online) => this.presence(fp, online),
        incoming: (tunnel) => this.incoming(tunnel),
        pair: (from, body, source) => this.pairIn(from, body, source),
      },
    });
  }

  start(): void {
    const { bus, mesh } = this.deps;
    mesh.setMeeting({
      addresses: (record) => this.relay.addresses(record.fingerprint),
      tunnel: (record) => (this.relay.online(record.fingerprint) ? this.relay.open(record.fingerprint) : undefined),
    });
    this.offs.push(
      bus.on('settings.updated', () => { this.syncPeers(); this.configure(); }),
      bus.on('device.upserted', () => this.syncPeers()),
      bus.on('device.removed', () => this.syncPeers()),
    );
    this.syncPeers();
    this.configure();
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    this.deps.mesh.setMeeting(undefined);
    this.relay.stop();
  }

  /** Host resume/unlock: the server connection may have died while asleep. */
  nudge(): void { this.relay.nudge(); }

  /** The peer listener moved: the server learns the new port. */
  portChanged(): void { this.syncPeers(); }

  state(): RelayState {
    const relay = this.relay.state();
    const ids = (fps: string[]) => fps.map((fp) => this.repo.byFingerprint(fp)).filter(linkedPc).map((record) => record.id);
    return {
      status: relay.status, ...(relay.url ? { url: relay.url } : {}), ...(relay.error && relay.status !== 'connected' ? { error: relay.error } : {}),
      peersOnline: ids(relay.online).length, relayed: ids(relay.tunnels),
    };
  }

  /**
   * "Connect" by Remote ID through the server: the PCs accepting requests under it (names are never sent to it).
   * Off, or not connected before `signal` ends: 'unavailable' with the reason find.ts shows (MEETING_OFF / MEETING_UNREACHABLE).
   */
  async find(remoteId: string, signal: AbortSignal): Promise<Found[]> {
    if (!(await this.connected(signal))) throw new WorkforceError('unavailable', this.relay.state().status === 'off' ? MEETING_OFF : MEETING_UNREACHABLE);
    const out: Found[] = [];
    for (const entry of await this.relay.find(remoteId, signal)) {
      this.boxes.set(entry.fp, entry.box);
      const who = await this.relay.request(entry.fp, entry.box, { op: 'wellKnown' }, { timeoutMs: WHO_TIMEOUT_MS, signal }).catch(() => undefined) as Record<string, unknown> | undefined;
      if (!who || who.ok !== true || who.fingerprint !== entry.fp || typeof who.deviceId !== 'string' || !/^dev_[0-9a-z]{10,40}$/.test(who.deviceId)) continue;
      out.push({ deviceId: who.deviceId, name: typeof who.name === 'string' ? who.name.slice(0, 60) : '', fingerprint: entry.fp, addresses: [`${RELAY_PREFIX}${entry.fp}`] });
    }
    return out;
  }

  /** A connect request step to `relay:<fingerprint>`; a stale box key (the PC reconnected) is looked up once more. */
  async post(address: string, body: unknown, options: PostOptions): Promise<unknown> {
    const fp = address.slice(RELAY_PREFIX.length);
    let box = this.boxes.get(fp) ?? (await this.lookup(fp, options.signal));
    if (!box) throw new Error('The other PC is not at the meeting server.');
    try {
      return await this.relay.request(fp, box, { op: 'pair', body }, options);
    } catch (error) {
      if (!String((error as Error)?.message).includes('(stale)')) throw error;
      box = await this.lookup(fp, options.signal);
      if (!box) throw error;
      return this.relay.request(fp, box, { op: 'pair', body }, options);
    }
  }

  // ---------------------------------------------------------------- internals

  /** True once the server connection is up; false when it is off or `signal` ends first (one wait, no polling). */
  private connected(signal: AbortSignal): Promise<boolean> {
    const status = () => this.relay.state().status;
    if (status() === 'connected') return Promise.resolve(true);
    if (status() === 'off' || signal.aborted) return Promise.resolve(false);
    this.relay.nudge(); // a reconnect waiting out its pause tries now
    return new Promise((resolve) => {
      const check = () => {
        const now = status();
        if (now !== 'connected' && now !== 'off' && !signal.aborted) return;
        this.waiters.delete(check);
        signal.removeEventListener('abort', check);
        resolve(now === 'connected');
      };
      this.waiters.add(check);
      signal.addEventListener('abort', check, { once: true });
    });
  }

  private async lookup(fp: string, signal?: AbortSignal): Promise<string | undefined> {
    const entries = await this.relay.find(remoteIdOf(fp), signal).catch(() => []);
    const box = entries.find((entry) => entry.fp === fp)?.box;
    if (box) this.boxes.set(fp, box);
    return box;
  }

  /** A linked PC came online at the server: the side with the smaller id connects now unless a link is up. */
  private presence(fp: string, online: boolean): void {
    if (!online) return;
    const record = this.repo.byFingerprint(fp);
    if (!linkedPc(record) || this.deps.identity.deviceId > record.id || this.deps.mesh.online(record.id)) return;
    void this.deps.mesh.connect(record.id).catch(() => undefined);
  }

  private incoming(tunnel: RelayTunnel): void {
    const phone = this.repo.byFingerprint(tunnel.peer);
    if (relayPhone(phone)) {
      const phones = this.deps.phones;
      if (!phones) { tunnel.close(); return; }
      void phones.accept(tunnel as SocketLike, phone).catch((error: unknown) => {
        this.deps.log.debug('phone tunnel refused', { error: String((error as Error)?.message ?? error) });
        tunnel.close();
      });
      return;
    }
    void this.deps.mesh.accept(tunnel as SocketLike).catch((error: unknown) => {
      this.deps.log.debug('meeting tunnel refused', { error: String((error as Error)?.message ?? error) });
      tunnel.close();
    });
  }

  private syncPeers(): void {
    const phonesOn = Boolean(this.deps.phones);
    const pinned = this.repo.list({ kinds: ['pc', 'phone'] }).filter((record) => linkedPc(record) || (phonesOn && relayPhone(record)));
    const peers = pinned.map((record) => ({ fp: record.fingerprint, pub: record.publicKey! }));
    // A removed phone stays pinned for a moment, so its open sockets still hear why they close (4403 "removed").
    const phones = new Map(pinned.filter((record) => relayPhone(record)).map((record) => [record.fingerprint, record.publicKey!]));
    const leaving = phonesOn ? [...this.phonePins].filter(([fp]) => !phones.has(fp)) : [];
    this.phonePins = phones;
    if (!phonesOn) this.leaving.clear();
    for (const [fp, pub] of leaving) this.leaving.set(fp, pub);
    for (const [fp, pub] of this.leaving) if (!phones.has(fp)) peers.push({ fp, pub });
    if (leaving.length) {
      const done = () => { for (const [fp] of leaving) this.leaving.delete(fp); this.syncPeers(); };
      if (this.deps.timers) this.deps.timers.set(done, PHONE_DRAIN_MS); else setTimeout(done, PHONE_DRAIN_MS).unref?.();
    }
    let port: number | undefined;
    try { port = this.deps.port(); } catch { port = undefined; }
    this.relay.setPeers(peers.slice(0, MAX_PEERS), this.findable(), port);
    this.changed();
  }

  private configure(): void {
    let url: string | undefined;
    try { url = relayAddress(this.deps.relayUrl() ?? ''); } catch { url = undefined; }
    this.relay.configure(url);
  }

  /**
   * A sealed message from a PC that found this one by Remote ID: who this PC is (id, name,
   * fingerprint), or a connect request step. It counts under the server's source tag, and a
   * request's device key must be the key that sent it through the server.
   */
  private async pairIn(from: string, value: unknown, source: string | undefined): Promise<unknown> {
    const message = value as { op?: unknown; body?: unknown };
    const refuse = (code: string, text: string) => ({ ok: false, error: { code, message: text } });
    if (!this.findable()) return refuse('forbidden', 'This PC does not accept connection requests.');
    if (message?.op === 'phone') return refuse('bad_request', PREVIEW_APP);
    if (message?.op === 'wellKnown') {
      const { deviceId, name, fingerprint } = this.deps.remote.wellKnown();
      return { ok: true, deviceId, name, fingerprint };
    }
    const body = message?.body as { kind?: unknown; device?: { pub?: unknown } } | null;
    const kind = body?.kind;
    if (message?.op !== 'pair' || typeof kind !== 'string' || !this.deps.remote.kinds.has(kind)) return refuse('bad_request', 'Not a connect request.');
    if (kind === 'remote1' && !keyOf(body?.device?.pub, from)) return refuse('bad_request', 'The request does not come from the PC it names.');
    return this.deps.remote.handle(message.body as Record<string, unknown>, { address: `${RELAY_PREFIX}${source ?? 'unknown'}` });
  }

  private findable(): boolean {
    try { return this.deps.findable(); } catch { return false; }
  }

  private changed(): void {
    for (const wake of [...this.waiters]) wake();
    const state = this.state();
    const text = JSON.stringify(state);
    if (text === this.lastState) return;
    this.lastState = text;
    try { this.deps.bus.emit('relay.updated', state); } catch (error) { this.deps.log.warn('meeting server state not sent', { error: String(error) }); }
  }
}

/** True when `pub` (base64url Ed25519) is the key with fingerprint `fp`. */
function keyOf(pub: unknown, fp: string): boolean {
  if (typeof pub !== 'string' || pub.length > 64) return false;
  const raw = fromB64url(pub);
  return raw.length === 32 && fingerprintOf(raw) === fp;
}
