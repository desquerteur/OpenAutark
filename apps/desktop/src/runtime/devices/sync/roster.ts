// The roster between my own devices (D1–D3, owner 06.11.2026: "einfach nur Connecten, dass es die gleiche Rolle ist wie
// der andere PC"; "du connectest das Handy mit der Firma"). One unit, 'sync.roster', travels only over 'ceo' links (my
// own PCs): every device row this PC knows – PCs and phones with their public key, addresses and relation (personId:
// my employee's PC; joinedAs 'employee': my employer's PC), removed ones as tombstones (only removals made since this PC
// keeps a roster – one from 0.3.x days stays local, so it never cuts a link another PC kept) – the phones' token hashes, the
// push subscriptions with the VAPID keys they were made under (held-push.ts), and this PC itself. It goes at a link-up
// and within SEND_MS of a change, to each PC only when it differs from the last one sent there.
// Taking one in: a device this PC does not know is added with the same relation – a PC through the mesh, so it dials it
// (my other PC: one group instead of pairs; my employer's PC: this PC becomes the same employee there), a phone as a
// client row with its tokens, so it opens here too. A removal wins over an older pairing, and a pairing after the
// removal wins over it. What changed here goes on to my other PCs; the per-PC hash stops the echo.
// Introductions over employer/employee links ('device.sibling', with their removals) live in siblings.ts; this class
// wires them to link-ups and removals.
// Owns: the roster unit and its merge. Never: links a PC the sender did not already trust, sends it over any other
// link, or logs a key, a token hash or an endpoint.

import { WorkforceError } from '../../../shared/errors.ts';
import type { RuntimeServices } from '../../contracts.ts';
import { KvRepo } from '../../store/kv.ts';
import { fingerprintOf, fromB64url } from '../keys.ts';
import type { DeviceMesh, LinkKind } from '../mesh.ts';
import { validAddress } from '../pair-proof.ts';
import { DevicesRepo, publicDevice, type DeviceRecord } from '../repo.ts';
import { heldKeys, heldSubs, keepKeys, keepSubs, localSubs, ownKey, type HeldSub, type KeyPair } from './held-push.ts';
import { linkOf, links, selfId } from './home.ts';
import { ROSTER_PEERS } from './notify.ts';
import { peerInfo, SIBLING_METHOD, Siblings } from './siblings.ts';
import { hashOf } from './stamps.ts';

export { SIBLING_METHOD } from './siblings.ts';
export const ROSTER_METHOD = 'sync.roster';
/** How long changes gather before the roster goes. */
export const SEND_MS = 500;

export interface RosterDevice {
  id: string; name: string; kind: 'pc' | 'phone' | 'browser'; fingerprint: string; pub?: string; addresses: string[];
  personId?: string; joinedAs?: 'ceo' | 'employee'; pairedAt?: number; revokedAt?: number;
}
export interface RosterToken { deviceId: string; kind: 'device' | 'person'; hash: string; scope: string; name?: string; createdAt: number; expiresAt?: number; revokedAt?: number }
export interface Roster { v: 1; devices: RosterDevice[]; tokens: RosterToken[]; subs: HeldSub[]; keys: KeyPair[]; vapid?: string }

export type RosterMesh = Pick<DeviceMesh, 'add' | 'revoke' | 'selfInfo'> & { register(method: string, handler: (params: unknown, from: string) => Promise<unknown>, kinds?: readonly LinkKind[]): void };

const errorText = (error: unknown) => String((error as Error)?.message ?? error);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const DEVICE_ID = /^dev_[0-9a-z]{10,40}$/;
/** kv: when this PC first kept a roster (the first start of B-078). */
const ROSTER_SINCE = { ns: 'sync.roster', key: 'since' };

function wireOf(record: DeviceRecord): RosterDevice {
  return {
    id: record.id, name: record.name, kind: record.kind, fingerprint: record.fingerprint, addresses: record.addresses,
    ...(record.publicKey ? { pub: record.publicKey } : {}), ...(record.personId ? { personId: record.personId } : {}),
    ...(record.joinedAs ? { joinedAs: record.joinedAs } : {}), ...(record.pairedAt ? { pairedAt: record.pairedAt } : {}),
    ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
  };
}

function validDevice(value: unknown): value is RosterDevice {
  const d = value as RosterDevice;
  return Boolean(d) && typeof d.id === 'string' && DEVICE_ID.test(d.id) && ['pc', 'phone', 'browser'].includes(d.kind) && typeof d.name === 'string'
    && d.name.length > 0 && d.name.length <= 60 && typeof d.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(d.fingerprint)
    && Array.isArray(d.addresses) && (d.pub === undefined || (typeof d.pub === 'string' && fromB64url(d.pub).length === 32));
}

export class RosterSync {
  private readonly s: RuntimeServices;
  private readonly mesh: RosterMesh;
  private readonly sent = new Map<string, string>();
  private timer?: ReturnType<typeof setTimeout>;
  private readonly sendMs: number;
  private readonly siblings: Siblings;

  constructor(s: RuntimeServices, mesh: RosterMesh, sendMs = SEND_MS) {
    this.s = s;
    this.mesh = mesh;
    this.sendMs = sendMs;
    mesh.register(ROSTER_METHOD, (params, from) => this.receive(params, from), ['ceo']);
    this.siblings = new Siblings(s, mesh);
    mesh.register(SIBLING_METHOD, (params, from) => this.sibling(params, from), ['ceo', 'employee', 'employer']);
    const kv = new KvRepo(s.db);
    if (kv.get(ROSTER_SINCE.ns, ROSTER_SINCE.key) === undefined) kv.set(ROSTER_SINCE.ns, ROSTER_SINCE.key, s.clock.now(), s.clock.now());
  }

  /** When this PC began to keep a roster: removals from before stay this PC's own (0.3.x never passed them on). */
  private since(): number {
    return Number(new KvRepo(this.s.db).get<number>(ROSTER_SINCE.ns, ROSTER_SINCE.key) ?? 0);
  }

  /** Listens to device and phone changes (a removal also drops the siblings only it introduced); returns the off switch. */
  attach(): () => void {
    const offs = [
      this.s.bus.on('device.upserted', (device) => { if (device?.status === 'revoked') this.siblings.dropOrphans(); this.later(); }),
      this.s.bus.on('pwa.updated', () => this.later()),
    ];
    return () => { for (const off of offs) off(); if (this.timer) clearTimeout(this.timer); this.timer = undefined; };
  }

  /** A link came up: my own PC gets the roster now; every link gets its introductions. */
  async linkUp(peer: string): Promise<void> {
    this.sent.delete(peer);
    if (linkOf(new DevicesRepo(this.s.db).get(peer))?.kind === 'ceo') await this.sendTo(peer, await this.build());
    await this.introduce();
  }

  /** This PC's roster as it travels. */
  async build(): Promise<Roster> {
    const repo = new DevicesRepo(this.s.db);
    const self = this.mesh.selfInfo();
    const since = this.since();
    const devices = repo.list({ includeRevoked: true })
      .filter((record) => !record.self && record.status !== 'pairing' && !(record.revokedAt !== undefined && record.revokedAt < since)).map(wireOf);
    devices.push({ id: self.id, name: self.name, kind: 'pc', fingerprint: fingerprintOf(fromB64url(self.pub)), pub: self.pub, addresses: self.addresses });
    const tokens = this.s.db.all<Record<string, unknown>>(
      "SELECT device_id, kind, hash, scope, name, created_at, expires_at, revoked_at FROM tokens WHERE kind IN ('device', 'person') AND device_id IS NOT NULL",
    ).map((row): RosterToken => ({
      deviceId: String(row.device_id), kind: row.kind as RosterToken['kind'], hash: String(row.hash), scope: String(row.scope), createdAt: Number(row.created_at),
      ...(row.name ? { name: String(row.name) } : {}), ...(num(row.expires_at) ? { expiresAt: Number(row.expires_at) } : {}), ...(num(row.revoked_at) ? { revokedAt: Number(row.revoked_at) } : {}),
    }));
    const own = await ownKey(this.s);
    const held = await heldKeys(this.s);
    return {
      v: 1, devices, tokens, subs: [...(own ? localSubs(this.s.db, own.pub, this.s.clock.now()) : []), ...heldSubs(this.s.db)],
      keys: [...(own ? [own] : []), ...[...held].map(([pub, priv]) => ({ pub, priv }))], ...(own ? { vapid: own.pub } : {}),
    };
  }

  private later(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.sendMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** The roster to every online 'ceo' PC it changed for. */
  async flush(): Promise<void> {
    const peers = links(this.s.db).filter(({ record, link }) => link.kind === 'ceo' && this.s.devices.online(record.id));
    if (!peers.length) return;
    const roster = await this.build();
    await Promise.all(peers.map(({ record }) => this.sendTo(record.id, roster)));
  }

  private async sendTo(peer: string, roster: Roster): Promise<void> {
    const h = hashOf(roster);
    if (this.sent.get(peer) === h) return;
    try {
      await this.s.devices.call(peer, ROSTER_METHOD, roster);
      this.sent.set(peer, h);
    } catch (error) {
      this.s.log.debug('roster not sent', { peer, error: errorText(error) }); // a PC on 0.3.x has no roster
    }
  }

  // ---------------------------------------------------------------- taking one in

  async receive(params: unknown, from: string): Promise<{ ok: true; changed: number }> {
    if (linkOf(new DevicesRepo(this.s.db).get(from))?.kind !== 'ceo') throw new WorkforceError('forbidden', 'A roster comes only from my own PCs.');
    const roster = (params ?? {}) as Partial<Roster>;
    new KvRepo(this.s.db).set(ROSTER_PEERS, from, true, this.s.clock.now());
    let changed = this.merge(Array.isArray(roster.devices) ? roster.devices.filter(validDevice) : [], from);
    changed += this.tokens(Array.isArray(roster.tokens) ? roster.tokens : []);
    const own = (await ownKey(this.s))?.pub;
    const keys = (Array.isArray(roster.keys) ? roster.keys : []).filter((key): key is KeyPair => typeof key?.pub === 'string' && typeof key.priv === 'string');
    if (await keepKeys(this.s, keys, own)) changed++;
    changed += this.subs(Array.isArray(roster.subs) ? roster.subs : [], own, typeof roster.vapid === 'string' ? roster.vapid : undefined);
    if (changed) this.later();
    await this.introduce();
    return { ok: true, changed };
  }

  /** Device rows: new ones added with the sender's relation, removals applied (see the header); returns how many changed. */
  private merge(devices: RosterDevice[], from: string): number {
    const repo = new DevicesRepo(this.s.db);
    const self = selfId(this.s.db);
    let changed = 0;
    for (const d of devices) {
      if (d.id === self || d.id === from) continue;
      const local = repo.get(d.id);
      try {
        if (d.revokedAt) {
          if (local && !local.revokedAt && (local.pairedAt ?? 0) <= d.revokedAt) { this.remove(local, d.revokedAt); changed++; }
          else if (!local) repo.upsert({ ...this.row(d), status: 'revoked', revokedAt: d.revokedAt });
          continue;
        }
        if (local?.revokedAt && local.revokedAt >= (d.pairedAt ?? 0)) continue; // the removal is newer than that pairing
        if (local && !local.revokedAt) {
          const addresses = d.addresses.filter((a) => typeof a === 'string' && validAddress(a)).slice(0, 8);
          if (local.kind === 'pc' && local.publicKey === d.pub && addresses.some((a) => !local.addresses.includes(a))) repo.patch(local.id, { addresses: [...new Set([...local.addresses, ...addresses])].slice(0, 8) });
          continue;
        }
        if (d.kind === 'pc') {
          if (!d.pub) continue;
          this.mesh.add(peerInfo({ ...d, pub: d.pub }), { side: 'joiner', ...(d.personId ? { personId: d.personId } : {}), ...(d.joinedAs === 'employee' ? { joinedAs: 'employee' as const } : {}) });
        } else {
          this.s.bus.emit('device.upserted', publicDevice(repo.upsert(this.row(d))));
        }
        changed++;
      } catch (error) {
        this.s.log.info('roster device not taken', { deviceId: d.id, error: errorText(error) });
      }
    }
    return changed;
  }

  private row(d: RosterDevice): DeviceRecord {
    const now = this.s.clock.now();
    return {
      id: d.id, name: d.name.trim().slice(0, 60), kind: d.kind, role: d.kind === 'pc' ? 'home' : 'client', fingerprint: d.fingerprint,
      ...(d.pub ? { publicKey: d.pub } : {}), addresses: d.kind === 'pc' ? d.addresses.filter((a) => typeof a === 'string' && validAddress(a)).slice(0, 8) : [],
      caps: {}, status: 'offline', self: false, pairedAt: d.pairedAt ?? now,
    };
  }

  private remove(local: DeviceRecord, at: number): void {
    if (local.kind === 'pc') { this.mesh.revoke(local.id); return; }
    this.s.db.run('UPDATE tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL', [at, local.id]);
    this.s.db.run('DELETE FROM push_subscriptions WHERE device_id = ?', [local.id]);
    const next = new DevicesRepo(this.s.db).patch(local.id, { status: 'revoked', revokedAt: at });
    if (next) this.s.bus.emit('device.upserted', publicDevice(next));
  }

  /** Phone token hashes: a phone's token opens every one of my PCs; a revoked one stays revoked. */
  private tokens(list: unknown[]): number {
    const repo = new DevicesRepo(this.s.db);
    let changed = 0;
    for (const raw of list) {
      const t = raw as RosterToken;
      if (!t || (t.kind !== 'device' && t.kind !== 'person') || typeof t.hash !== 'string' || !/^[0-9a-f]{64}$/.test(t.hash)) continue;
      if (typeof t.deviceId !== 'string' || typeof t.scope !== 'string' || t.scope.length > 2000) continue;
      const device = repo.get(t.deviceId);
      if (t.kind === 'device' && (!device || device.revokedAt)) continue;
      const result = this.s.db.run(
        `INSERT INTO tokens (id, device_id, kind, hash, scope, name, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET revoked_at = COALESCE(tokens.revoked_at, excluded.revoked_at) WHERE tokens.revoked_at IS NULL AND excluded.revoked_at IS NOT NULL`,
        [`tok_r${t.hash.slice(0, 24)}`, t.deviceId, t.kind, t.hash, t.scope, typeof t.name === 'string' ? t.name.slice(0, 60) : null, num(t.createdAt) ?? this.s.clock.now(), num(t.expiresAt) ?? null, num(t.revokedAt) ?? null],
      );
      changed += result.changes;
    }
    return changed;
  }

  /** Push subscriptions made under another PC's key are held here; the sender's own list replaces what it held before. */
  private subs(list: unknown[], own: string | undefined, senderKey: string | undefined): number {
    const repo = new DevicesRepo(this.s.db);
    const incoming = list.filter((raw): raw is HeldSub => {
      const sub = raw as HeldSub;
      return Boolean(sub) && typeof sub.endpoint === 'string' && sub.endpoint.startsWith('https://') && sub.endpoint.length <= 2000 && typeof sub.key === 'string'
        && sub.key !== own && typeof sub.data?.keys?.p256dh === 'string' && typeof sub.data.keys.auth === 'string';
    }).filter((sub) => !sub.deviceId || !repo.get(sub.deviceId)?.revokedAt);
    const before = heldSubs(this.s.db);
    const next = new Map(before.filter((sub) => !(senderKey && sub.key === senderKey) && !(sub.deviceId && repo.get(sub.deviceId)?.revokedAt)).map((sub) => [sub.endpoint, sub]));
    for (const sub of incoming) next.set(sub.endpoint, { endpoint: sub.endpoint, data: { endpoint: sub.endpoint, keys: { p256dh: sub.data.keys.p256dh, auth: sub.data.keys.auth } }, key: sub.key, ...(sub.deviceId ? { deviceId: sub.deviceId } : {}), ...(typeof sub.person === 'string' ? { person: sub.person } : {}) });
    const after = [...next.values()];
    if (hashOf(after) === hashOf(before)) return 0;
    keepSubs(this.s.db, after, this.s.clock.now());
    return 1;
  }

  // ---------------------------------------------------------------- introductions

  /** Names each of my other PCs (and each removed one) once over every online link to an employer or employee (siblings.ts). */
  introduce(): Promise<void> { return this.siblings.introduce(); }

  /** 'device.sibling' (siblings.ts). */
  sibling(params: unknown, from: string): Promise<{ ok: true }> { return this.siblings.receive(params, from); }
}
