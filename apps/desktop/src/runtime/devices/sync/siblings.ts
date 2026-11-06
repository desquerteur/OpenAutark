// Introductions between a person's PCs and a company's PCs ('device.sibling', open to every link kind; D2, owner
// 06.11.2026: a person's second PC works for the company like the first). Over each link to an employer or an employee
// this PC names each of my other PCs once; the company PC stores it with the same personId and tells its owner once,
// an employee's PC stores another PC of its company as an employer. Then both dial each other like any linked PC.
// Removals follow the introductions: a removed PC of mine goes out once over the same links as `{ info, revokedAt }`,
// and the PC there drops it when a PC of that same link introduced it (for a person: any PC of that person). When every
// PC that introduced a sibling is gone here, the sibling goes too. Only an unknown PC is ever added – a PC linked here
// keeps its relation whatever an introduction says.
// Storage: kv ns 'sync.sibling' (`<link>/<sibling>`: true = introduced there, 'removed' = its removal went there) and
// 'sync.sibling.by' (sibling id → the PCs that introduced it here).
// Owns: the introductions, their removals and the orphan drop. Never: links a PC the sender did not already trust,
// relabels a linked PC, or logs a key.

import type { RuntimeServices } from '../../contracts.ts';
import { KvRepo } from '../../store/kv.ts';
import type { DeviceMesh } from '../mesh.ts';
import { parseInfo, validAddress, type PeerInfo } from '../pair-proof.ts';
import { DevicesRepo, type DeviceRecord } from '../repo.ts';
import { linkOf, links, selfId, type Link } from './home.ts';

export const SIBLING_METHOD = 'device.sibling';
const INTRODUCED = 'sync.sibling';
const BY = 'sync.sibling.by';

type SiblingMesh = Pick<DeviceMesh, 'add' | 'revoke'>;
const errorText = (error: unknown) => String((error as Error)?.message ?? error);

export const peerInfo = (d: { id: string; name: string; pub: string; addresses: string[] }): PeerInfo =>
  ({ id: d.id, name: d.name, role: 'home', pub: d.pub, addresses: d.addresses.filter((a) => typeof a === 'string' && validAddress(a)).slice(0, 8) });

/** One of my own PCs as this PC stores it: no person, not an employer. */
const ownPc = (record: DeviceRecord) => record.kind === 'pc' && !record.self && !record.personId && record.joinedAs !== 'employee' && Boolean(record.publicKey);

/** Whether `record` stands in the relation the link `link` introduces (the person's PC, or another PC of my employer). */
const sameRelation = (record: DeviceRecord, link: Exclude<Link, { kind: 'ceo' }>) =>
  link.kind === 'employee' ? record.personId === link.personId : record.joinedAs === 'employee' && !record.personId;

export class Siblings {
  private readonly s: RuntimeServices;
  private readonly mesh: SiblingMesh;
  private dropping = false;

  constructor(s: RuntimeServices, mesh: SiblingMesh) {
    this.s = s;
    this.mesh = mesh;
  }

  /** Names each of my other PCs once over every online link to an employer or employee, and each removed one once. */
  async introduce(): Promise<void> {
    const all = links(this.s.db);
    const mine = all.filter(({ link, record }) => link.kind === 'ceo' && record.publicKey).map(({ record }) => record);
    const removed = new DevicesRepo(this.s.db).list({ includeRevoked: true, kinds: ['pc'] }).filter((record) => record.revokedAt && ownPc(record));
    const kv = new KvRepo(this.s.db);
    for (const { record: other, link } of all) {
      if (link.kind === 'ceo' || !this.s.devices.online(other.id)) continue;
      for (const sibling of mine) await this.send(kv, other.id, sibling, undefined);
      for (const sibling of removed) await this.send(kv, other.id, sibling, sibling.revokedAt);
    }
  }

  private async send(kv: KvRepo, to: string, sibling: DeviceRecord, revokedAt: number | undefined): Promise<void> {
    const key = `${to}/${sibling.id}`;
    const sent = kv.get<true | 'removed'>(INTRODUCED, key);
    if (revokedAt === undefined ? sent !== undefined : sent === 'removed') return;
    try {
      await this.s.devices.call(to, SIBLING_METHOD, { info: peerInfo({ ...sibling, pub: sibling.publicKey! }), ...(revokedAt === undefined ? {} : { revokedAt }) });
      kv.set(INTRODUCED, key, revokedAt === undefined ? true : 'removed', this.s.clock.now());
    } catch (error) {
      this.s.log.debug('device not introduced', { peer: to, sibling: sibling.id, error: errorText(error) });
    }
  }

  /** 'device.sibling': another PC of the person (or company) on that link – added with the same relation, or dropped. */
  async receive(params: unknown, from: string): Promise<{ ok: true }> {
    const repo = new DevicesRepo(this.s.db);
    const link = linkOf(repo.get(from));
    const p = (params ?? {}) as { info?: unknown; revokedAt?: unknown };
    const info = parseInfo(p.info);
    if (!link || link.kind === 'ceo' || !info || info.id === selfId(this.s.db) || info.id === from) return { ok: true }; // my own PCs share the roster instead
    const known = repo.get(info.id);
    const kv = new KvRepo(this.s.db);
    const by = kv.get<string[]>(BY, info.id) ?? [];
    if (typeof p.revokedAt === 'number' && Number.isFinite(p.revokedAt)) {
      const introduced = by.includes(from) || (link.kind === 'employee' && by.length > 0);
      if (known && !known.revokedAt && known.publicKey === info.pub && sameRelation(known, link) && introduced && (known.pairedAt ?? 0) <= p.revokedAt) this.mesh.revoke(known.id);
      return { ok: true };
    }
    if (known && !known.revokedAt && known.status !== 'revoked') {
      // Linked already: its relation stays. Another PC of the same link that names it is one more introducer.
      if (by.length && !by.includes(from) && known.publicKey === info.pub && sameRelation(known, link)) kv.set(BY, info.id, [...by, from], this.s.clock.now());
      return { ok: true };
    }
    if (known?.revokedAt && known.publicKey === info.pub) return { ok: true }; // removed here: stays removed
    if (link.kind === 'employee') {
      this.mesh.add(info, { side: 'joiner', personId: link.personId });
      const person = this.s.people?.get(link.personId)?.name ?? 'An employee';
      this.s.notifications.notify({ kind: 'important', title: `${person} added a device`, body: `${info.name} works for ${person} here now, like their other PC.` });
    } else {
      this.mesh.add(info, { side: 'joiner', joinedAs: 'employee' });
    }
    kv.set(BY, info.id, [from], this.s.clock.now());
    return { ok: true };
  }

  /** A PC was removed here: every sibling whose introducers are all gone goes too. */
  dropOrphans(): void {
    if (this.dropping) return; // a drop below announces itself again
    this.dropping = true;
    try {
      const repo = new DevicesRepo(this.s.db);
      for (let round = 0; round < 8; round++) {
        let dropped = 0;
        for (const { key, value } of new KvRepo(this.s.db).list<string[]>(BY)) {
          const sibling = repo.get(key);
          if (!sibling || sibling.revokedAt || sibling.status === 'revoked' || !Array.isArray(value) || !value.length) continue;
          if (value.some((introducer) => linkOf(repo.get(introducer)))) continue;
          try { this.mesh.revoke(sibling.id); dropped++; } catch (error) { this.s.log.debug('sibling not dropped', { sibling: sibling.id, error: errorText(error) }); }
        }
        if (!dropped) return;
      }
    } finally {
      this.dropping = false;
    }
  }
}
