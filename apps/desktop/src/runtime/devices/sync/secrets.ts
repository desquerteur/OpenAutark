// Secrets between the CEO's own PCs (mesh method 'sync.secret'; owner 04.11.2026: "auch sowas wie Passwörter …
// API-Keys"): an entry's metadata and its value. The sender decrypts each value with its own keychain at send time;
// it travels only inside the encrypted, key-pinned mesh channel (channel.ts), and the receiver stores it under the
// same id with its own keychain through the vault (save / saveGroup – its redactor learns it there). A single secret
// or a whole group (a login, a card) is one unit with one stamp (stamps.ts, key 'secret/<id>'); a removal travels as
// a tombstone; at the first link the joiner takes the other PC's entry for an id both have and keeps its own, when it
// differs, under a new id. API-key accounts follow, because their key is a secret. An employee's PC gets none and sends none.
// Owns: sending and storing these units (a unit is read in secrets/units.ts). Never: logs, journals or returns a value,
// or sends one to a PC that is no 'ceo' link.

import type { RuntimeServices } from '../../contracts.ts';
import type { Db } from '../../db/database.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import type { SecretGroupKind, SecretInfo } from '../../../shared/model/security.ts';
import { fieldRows, groupRow } from '../../secrets/groups.ts';
import { newEntryId } from '../../secrets/entry-id.ts';
import { readUnit, type SecretUnit } from '../../secrets/units.ts';
import { DevicesRepo } from '../repo.ts';
import { linkOf, links } from './home.ts';
import { hashOf, wins, type Stamp, type Stamps } from './stamps.ts';

type Unit = SecretUnit;
interface Item { id: string; at: number; unit?: Unit; gone?: true }

const PREFIX = 'secret/';
const PAGE = 50;

const code = (error: unknown) => (error instanceof WorkforceError ? error.code : 'failed'); // an error text could quote input: only its code is logged
const valid = (item: unknown): item is Item => {
  const value = item as Item;
  return Boolean(value) && typeof value.id === 'string' && value.id.length <= 200 && typeof value.at === 'number'
    && (value.gone === true || (Boolean(value.unit) && typeof value.unit!.label === 'string' && typeof value.unit!.kind === 'string'));
};

/** What a unit holds, to compare two (never logged). */
const valuesOf = (unit: Unit) => hashOf(unit.group ? (unit.fields ?? []).map((field) => [field.field, field.kind, field.value ?? '']).sort() : [unit.kind, unit.value ?? '']);

/** A unit's id: a grouped field belongs to its group. */
const unitOf = (db: Db, id: string) => db.get<{ group_id: string | null }>('SELECT group_id FROM secrets WHERE id = ?', [id])?.group_id ?? id;
const existsHere = (db: Db, id: string) => Boolean(groupRow(db, id) || db.get('SELECT 1 FROM secrets WHERE id = ? AND group_id IS NULL', [id]));

export class SecretSync {
  private readonly s: RuntimeServices;
  private readonly stamps: Stamps;
  /** Ids being written from another PC: their change notices are no change here. */
  private readonly applying = new Set<string>();
  private readonly pending = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(s: RuntimeServices, stamps: Stamps) {
    this.s = s;
    this.stamps = stamps;
  }

  attach(): () => void {
    return this.s.secrets.observe?.((id) => {
      if (this.applying.has(id)) return;
      this.pending.add(id);
      if (this.timer) return;
      this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 0);
      (this.timer as { unref?: () => void }).unref?.();
    }) ?? (() => {});
  }

  private ceoPeers(except?: string): string[] {
    return links(this.s.db).filter(({ record, link }) => link.kind === 'ceo' && record.id !== except).map(({ record }) => record.id);
  }

  private async flush(): Promise<void> {
    const ids = new Set([...this.pending].map((id) => unitOf(this.s.db, id)));
    this.pending.clear();
    const items: Item[] = [];
    for (const id of ids) {
      const key = PREFIX + id;
      const stamp = this.stamps.next(this.stamps.get(key), '', !existsHere(this.s.db, id));
      this.stamps.set(key, stamp);
      const item = await this.item(id, stamp);
      if (item) items.push(item);
    }
    for (const peer of this.ceoPeers()) if (this.s.devices.online(peer)) await this.post(peer, items);
  }

  /** One unit as it leaves: metadata and the value decrypted now (undefined when it cannot be read here). */
  private async item(id: string, stamp: Stamp): Promise<Item | undefined> {
    if (stamp.gone) return { id, at: stamp.at, gone: true };
    try {
      const unit = await this.read(id);
      return unit ? { id, at: stamp.at, unit } : { id, at: stamp.at, gone: true };
    } catch (error) {
      this.s.log.warn('secret not sent', { id, error: code(error) });
      return undefined;
    }
  }

  private read(id: string): Promise<Unit | undefined> {
    return readUnit(this.s.db, (cipher) => this.s.host.decrypt(cipher), id);
  }

  private async post(peer: string, items: Item[]): Promise<boolean> {
    if (!items.length) return true;
    try {
      await this.s.devices.call(peer, 'sync.secret', { items });
      return true;
    } catch (error) {
      this.s.log.info('secrets not sent', { peer, count: items.length, error: code(error) });
      return false;
    }
  }

  /** What the link-up owes a CEO PC: every unit the first time, else those stamped after `since`. */
  async catchUp(peer: string, since: number | undefined): Promise<boolean> {
    if (linkOf(new DevicesRepo(this.s.db).get(peer))?.kind !== 'ceo') return true;
    const db = this.s.db;
    const ids = since === undefined
      ? [...db.all<{ id: string }>('SELECT id FROM secret_groups ORDER BY rowid'), ...db.all<{ id: string }>('SELECT id FROM secrets WHERE group_id IS NULL ORDER BY rowid')].map((row) => row.id)
      : this.stamps.since(PREFIX, since).map(({ key }) => key.slice(PREFIX.length));
    let ok = true;
    for (let index = 0; index < ids.length; index += PAGE) {
      const items: Item[] = [];
      for (const id of ids.slice(index, index + PAGE)) {
        const item = await this.item(id, this.stamps.get(PREFIX + id) ?? { at: 0, h: '' });
        if (item) items.push(item);
      }
      ok = (await this.post(peer, items)) && ok;
    }
    return ok;
  }

  /** 'sync.secret' from a CEO PC: units that win are stored here (same ids) and passed on to the other CEO PCs. */
  async receive(params: unknown, from: string): Promise<{ ok: true; applied: number }> {
    const record = new DevicesRepo(this.s.db).get(from);
    if (linkOf(record)?.kind !== 'ceo') throw new WorkforceError('forbidden', 'Secrets come only from the CEO\'s own PCs.');
    const list = (params as { items?: unknown } | null)?.items;
    const items = (Array.isArray(list) ? list : []).filter(valid);
    const applied: Item[] = [];
    for (const item of items) {
      const key = PREFIX + item.id;
      const local = this.stamps.get(key) ?? (existsHere(this.s.db, item.id) ? { at: 0, h: '' } : undefined);
      if (local && local.at === item.at && item.at !== 0) continue; // the same change, back again
      if (!wins({ at: item.at, h: '' }, local, Boolean(record?.joinedAs))) continue;
      try {
        if (local?.at === 0 && item.at === 0 && item.unit && existsHere(this.s.db, item.id)) await this.keepOwn(item.id, item.unit);
        await this.apply(item);
        this.stamps.set(key, { at: item.at, h: '', ...(item.gone ? { gone: true as const } : {}) });
        applied.push(item);
      } catch (error) {
        this.s.log.warn('synced secret not stored', { id: item.id, error: code(error) });
      }
    }
    for (const peer of this.ceoPeers(from)) if (this.s.devices.online(peer)) await this.post(peer, applied);
    return { ok: true, applied: applied.length };
  }

  /**
   * The first link and both PCs have this id (e.g. `sec_github` made from the same name): this PC's own entry stays,
   * under a new id, when its values differ – then it travels like a new one.
   */
  private async keepOwn(id: string, incoming: Unit): Promise<void> {
    const own = await this.read(id);
    if (!own || valuesOf(own) === valuesOf(incoming)) return;
    const vault = this.s.secrets;
    const copy = newEntryId(vault.list(), vault.groups(), own.label);
    const common = { label: own.label, description: own.description, tags: own.tags, ...(own.source ? { source: own.source } : {}), ...(own.route ? { route: own.route } : {}) };
    if (own.group) {
      const fields = (own.fields ?? []).map((field) => ({ field: field.field, kind: field.kind, ...(field.value !== undefined ? { value: field.value } : {}) }));
      await vault.saveGroup({ id: copy, kind: own.kind as SecretGroupKind, ...common, fields });
    } else {
      await vault.save({ id: copy, kind: own.kind as SecretInfo['kind'], ...(own.value !== undefined ? { value: own.value } : {}), ...common });
    }
    this.s.log.info('own secret kept beside the linked PC\'s', { id, copy });
  }

  private async apply(item: Item): Promise<void> {
    const { db } = this.s;
    const vault = this.s.secrets;
    const ids = [item.id, ...(item.unit?.fields ?? []).map((field) => field.id), ...fieldRows(db, item.id).map((row) => row.id)];
    for (const id of ids) this.applying.add(id);
    try {
      const unit = item.unit;
      if (item.gone || !unit) {
        if (groupRow(db, item.id)) vault.removeGroup(item.id);
        else if (db.get('SELECT 1 FROM secrets WHERE id = ?', [item.id])) vault.remove(item.id);
        return;
      }
      const common = { label: unit.label, description: unit.description, tags: unit.tags, ...(unit.source ? { source: unit.source } : {}), ...(unit.route ? { route: unit.route } : {}) };
      if (!unit.group) {
        await vault.save({ id: item.id, kind: unit.kind as SecretInfo['kind'], ...(unit.value !== undefined ? { value: unit.value } : {}), ...common });
        return;
      }
      const local = fieldRows(db, item.id);
      const fields = (unit.fields ?? []).filter((field) => field.value || local.some((row) => row.id === field.id));
      await vault.saveGroup({
        id: item.id, ...(groupRow(db, item.id) ? {} : { kind: unit.kind as SecretGroupKind }), ...common, fields,
        remove: local.filter((row) => !fields.some((field) => field.id === row.id)).map((row) => row.id),
      });
    } finally {
      for (const id of ids) this.applying.delete(id);
    }
  }
}
