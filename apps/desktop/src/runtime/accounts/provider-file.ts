// settings.json's `providers` section ↔ the accounts table: the file says which API connections there are, the table
// keeps what happens to them (state, limits, priority, on/off). sync() runs at the start and after every
// settings.updated: an entry becomes the account with that id, a changed entry changes it (and it is checked again), a
// removed one goes. What the form and accounts.add connect is written here as an entry, so there is one way in.
// Once: API connections from before the file move in (moveOld, run at each start like legacy.ts, so nothing is left to
// move afterwards): each gets an id from its service or address, keeps its key as a handle, its state and its place in
// the runs, and routing.voice follows when it named the old id. Plans, keys from the environment and local servers the
// PC scan found stay detected. The ids the file owned at the last sync live in kv (ns 'accounts'), so a row
// that was never in the file is never removed by it.
// Owns: these rules. Never: reads a key value, or decides what an entry means (shared/model/provider-entries.ts).

import type { Db } from '../db/database.ts';
import type { Logger, SettingsService } from '../contracts.ts';
import { MEDIA_ONLY_PROVIDERS, type Account, type ProviderId } from '../../shared/model/providers.ts';
import { entryConnection, protocolOfProvider, providerIdFree, type ProviderEntries, type ProviderEntry } from '../../shared/model/provider-entries.ts';
import { hostOf, serviceOfAccount } from '../../shared/model/providers-connect.ts';
import type { SettingsPatch } from '../../shared/model/system.ts';
import { DEFAULT_BASE } from '../engines/http/common.ts';
import { KvRepo } from '../store/kv.ts';
import { CLI_PROVIDERS } from './adoption.ts';
import { handleId, type Connection } from './connect.ts';
import type { AccountRepo } from './repo.ts';

export type ProviderSettings = Pick<SettingsService, 'get' | 'update' | 'notice'>;

export interface ProviderFileDeps {
  db: Db;
  repo: AccountRepo;
  settings: ProviderSettings;
  now(): number;
  save(account: Account): Account;
  blank(provider: ProviderId, patch: Partial<Account>): Account;
  /** Takes a removed entry's account out (AccountService). */
  forget(account: Account): void;
  /** One check in the monitor's queue. */
  check(id: string): void;
  log?: Logger;
}

const NS = 'accounts';
const KEY = 'file-ids';
const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 36);

/** The entry that says what `account` is. */
export function entryOfAccount(account: Pick<Account, 'provider' | 'baseUrl' | 'label' | 'secretId'>): ProviderEntry {
  const url = account.baseUrl ?? DEFAULT_BASE[account.provider];
  const secret = account.secretId ? handleId(account.secretId) ?? account.secretId : undefined;
  return {
    name: account.label, ...(MEDIA_ONLY_PROVIDERS.includes(account.provider) ? {} : { protocol: protocolOfProvider(account.provider) }), // a media service speaks its own
    ...(url ?{ url: url.replace(/\/+$/, '') } : {}), ...(secret ? { key: `secret://${secret}` } : {}),
  };
}

export class ProviderFile {
  private readonly deps: ProviderFileDeps;
  private last: string | undefined;

  constructor(deps: ProviderFileDeps) { this.deps = deps; }

  private entries(): ProviderEntries { return this.deps.settings.get().providers ?? {}; }
  private kv(): KvRepo { return new KvRepo(this.deps.db); }
  private owned(): string[] { return this.kv().get<string[]>(NS, KEY) ?? []; }
  /** The section may say less than is meant: it was not applied, or the file could not be used at all (at a start that reads as no entries). */
  private unapplied(): boolean {
    const notice = this.deps.settings.notice?.();
    if (!notice) return false;
    const sections = /^settings\.json: (.+?) (?:was|were) not applied/.exec(notice)?.[1].split(', ');
    return !sections || sections.includes('providers') || sections.includes('settings');
  }

  /** The file names this account. */
  has(id: string): boolean { return Object.hasOwn(this.entries(), id); }

  /** The accounts follow the file. */
  sync(): void {
    const entries = this.entries();
    const text = JSON.stringify(entries);
    if (text === this.last) return;
    this.last = text;
    const { repo, save, blank, check, forget } = this.deps;
    for (const [id, entry] of Object.entries(entries)) {
      const want = entryConnection(id, entry);
      if ('problem' in want) continue; // the settings check keeps such an entry out
      const row = repo.get(id);
      if (!row) {
        save(blank(want.provider, { id, ...want, state: 'unknown', detected: false }));
        check(id);
        continue;
      }
      const moved = row.provider !== want.provider || row.baseUrl !== want.baseUrl || row.secretId !== want.secretId || row.auth !== want.auth;
      if (!moved && row.label === want.label) continue;
      const next: Account = { ...row, ...want, ...(want.secretId ? {} : { secretId: undefined }), ...(want.baseUrl ? {} : { baseUrl: undefined }) };
      save(moved ? { ...next, state: row.enabled ? 'unknown' : 'disabled', limits: undefined, coolingUntil: undefined } : next);
      if (moved && row.enabled) check(id);
    }
    if (this.unapplied()) { this.last = undefined; return; } // says nothing about what is gone; the next sync looks again
    for (const id of this.owned()) {
      if (Object.hasOwn(entries, id)) continue;
      const row = repo.get(id);
      if (row) forget(row);
    }
    this.kv().set(NS, KEY, Object.keys(entries), this.deps.now());
  }

  /** A free id for a new connection: its service (a remote one only at its own address: "anthropic:<model>" never names a proxy), else its name, else its address. */
  private freeId(account: Pick<Account, 'provider' | 'baseUrl' | 'label'>, taken: ReadonlySet<string>): string {
    const service = serviceOfAccount(account);
    const known = service && (service.kind === 'local' || !account.baseUrl || hostOf(account.baseUrl) === hostOf(service.base)) ? service.id : undefined;
    const base = [known, slug(account.label), slug(hostOf(account.baseUrl) ?? ''), 'connection'].find((name) => name && providerIdFree(name))!;
    let id = base;
    for (let n = 2; taken.has(id) || this.deps.repo.get(id) || !providerIdFree(id); n += 1) id = `${base}-${n}`;
    return id;
  }

  /** A new connection: an entry in the file, and through it the account. */
  add(input: { provider: ProviderId; label: string; rotation?: boolean }, connection: Connection): Account {
    const shape = { provider: input.provider, baseUrl: connection.baseUrl, label: input.label, secretId: connection.secretId };
    const id = this.freeId(shape, new Set(Object.keys(this.entries())));
    this.write({ providers: { [id]: entryOfAccount(shape) } });
    const account = this.deps.repo.get(id);
    if (!account) throw new Error(`The connection ${id} was not added.`);
    return input.rotation ? this.deps.save({ ...account, rotation: true }) : account;
  }

  /** The new name of a connection. */
  rename(id: string, label: string): void { this.write({ providers: { [id]: { name: label } } }); }

  /** The connection leaves the file, and with it its account (sync). */
  remove(id: string): void { this.write({ providers: { [id]: null } } as unknown as SettingsPatch); }

  private write(patch: SettingsPatch): void {
    this.deps.settings.update(patch);
    this.sync(); // the service hears settings.updated too; this covers a settings service without a bus
  }

  /** Once: the API connections from before the file move in. */
  moveOld(): void {
    const { repo, db } = this.deps;
    if (this.unapplied()) return;
    const entries = this.entries();
    const owned = new Set(this.owned());
    const old = repo.list().filter((account) => !Object.hasOwn(entries, account.id) && !owned.has(account.id) && !account.deviceId && !account.detected
      && !CLI_PROVIDERS.has(account.provider) && (account.auth === 'api_key' || account.auth === 'none' || account.auth === 'local'));
    if (!old.length) return;
    const taken = new Set(Object.keys(entries));
    const moves = old.map((account) => {
      const entry = entryOfAccount(account);
      const same = Object.entries(entries).find(([, other]) => other.url === entry.url && other.key === entry.key)?.[0]; // a move that stopped half-way
      const id = same ?? this.freeId(account, taken);
      taken.add(id);
      return { account, id, entry, same: same !== undefined };
    });
    const providers = Object.fromEntries(moves.filter((move) => !move.same).map((move) => [move.id, move.entry]));
    const voice = this.deps.settings.get().routing.voice;
    const named = moves.find((move) => voice.startsWith(`${move.account.id}:`));
    this.deps.settings.update({ providers, ...(named ? { routing: { voice: `${named.id}:${voice.slice(named.account.id.length + 1)}` } } : {}) });
    this.sync();
    db.tx(() => {
      for (const { account, id } of moves) {
        const row = repo.get(id);
        repo.save({ ...account, ...(row ? { provider: row.provider, baseUrl: row.baseUrl, secretId: row.secretId, auth: row.auth, label: row.label } : {}), id, state: account.enabled ? 'unknown' : 'disabled' });
        repo.remove(account.id);
        db.run('UPDATE runs SET account_id = ? WHERE account_id = ?', [id, account.id]);
        db.run('UPDATE engine_sessions SET account_id = ? WHERE account_id = ?', [id, account.id]);
      }
    });
    const catalog = this.kv();
    for (const { account, id } of moves) {
      const listing = catalog.get<unknown>('catalog', `listing:${account.id}`);
      if (listing) catalog.set('catalog', `listing:${id}`, listing, this.deps.now());
      catalog.delete('catalog', `listing:${account.id}`);
    }
    catalog.delete('catalog', 'refreshed_at'); // the model ids change with the next list
    this.deps.log?.info('API connections moved into settings.json', { connections: moves.length });
  }
}
