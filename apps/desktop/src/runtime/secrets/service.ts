// SecretService: encrypted secret store (OS keychain via host.encrypt/decrypt) with handles.
// Owns: the `secrets` table, last-use tracking, the redaction
// matcher that turns leaked values into `secret://<id>`, generated passwords (crypto.randomInt) and the host helpers
// (hostOf, registrableDomain, domainAllowed – used to NAME where a value came from or goes, never to restrict it).
// Owner 29.10.2026 (secrets as a catalog like skills, with its Nachtrag): the store is a
// catalog like a skill with ZERO restrictions – no entry is tied to a site, neither by the app nor by the person, card
// data included: every secret works everywhere (browser fills on any site, command env, headers to any host, apps).
// Each entry has a route (its catalog area, chosen automatically unless named), usage tags (information only) and a
// source (where the value came from – provenance only). Every entry is for every agent.
// X05: grouped secrets (groups.ts) – a login or card is a group whose fields have their own handles. A 2FA setup key
// ('totp') is stored as canonical JSON and use() returns only the current code (RFC 6238, totp.ts) – also to the
// person; the redactor learns the key in any spelling, never a 'text' field, and a single secret changes to or from
// those kinds only with a new value. What an agent creates is recorded as its own (created_by, information only).
// B-044: every change of an entry's metadata – saved, described, generated, captured, removed – is told to the
// observers (the route files <data>/secrets/<route>.md, files.ts) with the id of the single secret or group.
// Owner 04.11.2026: a text field's hint is the text itself (groups.ts textHint); init() brings older hints up to that.
// Never: returns values to prompts, logs or the UI (a text field – a username – is no secret: its hint shows it); stores
// plaintext; returns a 2FA key at all. Tools call `use()` at the last possible moment.

import { createHmac, randomBytes, randomInt } from 'node:crypto';
import type { Clock, Logger, SecretService } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { json, toJson } from '../db/database.ts';
import type { Host } from '../host.ts';
import type { SecretGroup, SecretGroupInput, SecretGroupSaved, SecretInfo } from '../../shared/model/security.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { Redactor } from './redact.ts';
import {
  cleanRoute, cleanTags, deleteGroup, fieldRows, generatedLogin, groupList, groupRow, planGroup, redactionOf, SECRET_KINDS,
  storedForm, textHint, toGroup, toInfo, writeGroup, type GroupRow, type SecretRow,
} from './groups.ts';
import { autoSecretRoute } from '../../shared/model/security.ts';
import { readTotp, totpCode } from './totp.ts';
import { newEntryId } from './entry-id.ts';

/** A code with less time left than this is not filled: the next window's code is (after one wait). */
const MIN_CODE_MS = 3000;
/** Kinds whose stored form differs from what was typed (a 2FA key's JSON) or that the redactor never learns: changed to or from only with a new value. */
const RESHAPED: ReadonlySet<string> = new Set(['totp', 'text']);
/** Second-level labels under which registrations sit one level deeper (example.co.uk). */
const SECOND_LEVEL: ReadonlySet<string> = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gv', 'mil']);
/** Shared hosting whose subdomains belong to different people: treated like public suffixes. */
const SHARED_SUFFIXES: readonly string[] = [
  'github.io', 'gitlab.io', 'bitbucket.io', 'herokuapp.com', 'blogspot.com', 'wordpress.com', 'tumblr.com', 'netlify.app',
  'vercel.app', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'appspot.com', 'azurewebsites.net',
  'azurestaticapps.net', 'cloudfront.net', 's3.amazonaws.com', 'onrender.com', 'fly.dev', 'glitch.me', 'myshopify.com',
  'wixsite.com', 'webflow.io', 'surge.sh', 'readthedocs.io', 'ngrok.io', 'ngrok-free.app', 'replit.app', 'repl.co', 'duckdns.org',
];
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!#$%&*+-=?@_~';

/** The host name of a URL or host: lower-case, without port or trailing dot, www kept (undefined when none). */
function urlHost(value: string | undefined): string | undefined {
  const raw = value?.trim().toLowerCase();
  if (!raw || /\s/.test(raw)) return undefined;
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`).hostname.replace(/\.$/, '') || undefined; } catch { return undefined; }
}

const withoutWww = (host: string) => host.replace(/^www\d*\./, '');

/** The host of a URL or host name: lower-case, without port, trailing dot or leading www (undefined when none). */
export function hostOf(value: string | undefined): string | undefined {
  const full = urlHost(value);
  const host = full === undefined ? undefined : withoutWww(full);
  return host && (host.includes('.') || host.startsWith('[')) ? host : undefined;
}

/**
 * The registrable domain of a host ("accounts.example.co.uk" → "example.co.uk"): the last two
 * labels, three under a two-letter country code with a generic second level (co.uk, com.au …),
 * one label more than a shared hosting suffix ("alice.github.io" stays "alice.github.io").
 * IP addresses stay as they are. No public suffix list (nothing is downloaded): a rough rule
 * that errs towards the longer, narrower domain.
 */
export function registrableDomain(value: string | undefined): string | undefined {
  const host = hostOf(value);
  if (!host) return undefined;
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith('[')) return host;
  const labels = host.split('.');
  const shared = SHARED_SUFFIXES.find((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (shared) return labels.slice(-(shared.split('.').length + 1)).join('.');
  if (labels.length <= 2) return host;
  const [second, top] = labels.slice(-2);
  return labels.slice(top.length === 2 && SECOND_LEVEL.has(second) ? -3 : -2).join('.');
}

/**
 * One domain rule as the person may type it: an optional "*." (subdomains only), then a host or
 * URL. `exact`: it named a www host ("www.bank.example" is that site, not every subdomain).
 */
function ruleOf(entry: string): { host: string; wildcard: boolean; exact: boolean } | undefined {
  const raw = entry.trim().toLowerCase();
  const wildcard = raw.startsWith('*.');
  const full = urlHost(wildcard ? raw.slice(2) : raw);
  if (!full) return undefined;
  const bare = withoutWww(full);
  const host = wildcard || !bare.includes('.') ? full : bare;
  return { host, wildcard, exact: host !== full };
}

/** A random password with upper, lower and digit (and a symbol when asked) – crypto.randomInt only. */
export function generatePassword(length = 20, symbols = true): string {
  const size = Math.max(12, Math.min(64, Math.floor(length)));
  const pools = [UPPER, LOWER, DIGITS, ...(symbols ? [SYMBOLS] : [])];
  const all = pools.join('');
  const chars = pools.map((pool) => pool[randomInt(pool.length)]);
  while (chars.length < size) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * `example.com` matches example.com and *.example.com; `*.x.com` matches subdomains only;
 * `www.x.com` matches www.x.com and x.com. Both sides are read as hosts (see ruleOf), so rules
 * stored with a scheme, path or www work like the person meant them.
 */
export function domainAllowed(domain: string, allowed: string[]): boolean {
  const full = urlHost(domain);
  if (!full) return false;
  const bare = withoutWww(full);
  return allowed.some((entry) => {
    const rule = ruleOf(entry);
    if (!rule) return false;
    if (rule.wildcard) return full.endsWith(`.${rule.host}`);
    return bare === rule.host || full === rule.host || (!rule.exact && bare.endsWith(`.${rule.host}`));
  });
}

export interface SecretServiceOptions {
  db: Db;
  host: Pick<Host, 'encrypt' | 'decrypt'>;
  clock: Clock;
  log?: Logger;
  /** X05: waits once before a 2FA code with under 3 s left (default: an unref'd setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); (timer as { unref?: () => void }).unref?.(); });

export type SecretSaveInput = Parameters<SecretService['save']>[0];

/** B-044: hears the id of a single secret, a group or a grouped field whose metadata changed or went (files.ts). */
export type SecretObserver = (id: string) => void;

export class SecretVault implements SecretService {
  private options: SecretServiceOptions;
  private redactor = new Redactor();
  private readonly observers = new Set<SecretObserver>();
  private readonly printKey = randomBytes(32);

  constructor(options: SecretServiceOptions) {
    this.options = options;
  }

  /** B-044: `listener` hears every metadata change (see the header); returns the unsubscribe function. */
  observe(listener: SecretObserver): () => void {
    this.observers.add(listener);
    return () => { this.observers.delete(listener); };
  }

  private changed(...ids: string[]): void {
    for (const listener of [...this.observers]) {
      for (const id of ids) {
        try { listener(id); } catch (error) { this.options.log?.warn('secret observer failed', { id, error: String(error) }); }
      }
    }
  }

  /** Decrypts every stored value once into the in-memory redaction matcher (call at startup); a text field's older hint becomes the text. */
  async init(): Promise<void> {
    for (const row of this.options.db.all<SecretRow>('SELECT * FROM secrets WHERE cipher IS NOT NULL')) {
      try {
        const value = await this.options.host.decrypt(row.cipher!);
        this.teach(row.id, row.kind, value);
        const hint = row.kind === 'text' ? textHint(value) ?? null : row.hint;
        if (hint !== row.hint) this.options.db.run('UPDATE secrets SET hint = ? WHERE id = ?', [hint, row.id]);
      } catch {
        this.options.log?.warn('secret could not be decrypted for redaction', { id: row.id });
      }
    }
  }

  list(): SecretInfo[] {
    const groups = new Map(groupList(this.options.db).map((group) => [group.id, group]));
    return this.options.db.all<SecretRow>('SELECT * FROM secrets ORDER BY label COLLATE NOCASE, id')
      .map((row) => toInfo(row, row.group_id ? groups.get(row.group_id) : undefined));
  }

  /** X05: a grouped row (or `groupId` + `field`) is saved through its group – route and tags go to the GROUP. */
  async save(input: SecretSaveInput): Promise<SecretInfo> {
    const label = input.label.trim();
    if (!label) throw new WorkforceError('bad_request', 'A secret needs a label.');
    if (label.length > 120) throw new WorkforceError('bad_request', 'A secret name may have at most 120 characters.');
    if (!SECRET_KINDS.includes(input.kind)) throw new WorkforceError('bad_request', `Unknown secret kind: ${String(input.kind).slice(0, 20)}.`);
    const db = this.options.db;
    const existing = input.id ? db.get<SecretRow>('SELECT * FROM secrets WHERE id = ?', [input.id]) : undefined;
    const description = this.redact(input.description ?? existing?.description ?? '').trim();
    if (description.length > 4000) throw new WorkforceError('bad_request', 'A secret description may have at most 4000 characters.');
    if (existing && existing.kind !== input.kind && !input.value && (RESHAPED.has(existing.kind) || RESHAPED.has(input.kind))) {
      throw new WorkforceError('bad_request', 'Changing a secret to or from a 2FA key or a text field needs its value again.');
    }
    const groupId = existing?.group_id ?? input.groupId;
    if (groupId) {
      const field = { id: existing?.id ?? input.id, field: existing?.field ?? input.field ?? '', kind: input.kind, value: input.value };
      const saved = await this.saveGroup({ id: groupId, route: input.route, tags: input.tags, ...(input.source ? { source: input.source } : {}), fields: [field] });
      return saved.fields.find((info) => info.field === field.field)!;
    }
    const id = existing?.id ?? input.id ?? newEntryId(this.list(), this.groups(), label); // owner 29.10.2026: generated from the name
    const form = input.value ? storedForm(input.kind, input.value) : undefined;
    const cipher = form ? await this.options.host.encrypt(form.stored) : existing?.cipher ?? null;
    const hint = input.hint ?? form?.hint ?? existing?.hint ?? null;
    const source = input.source ?? existing?.source ?? null;
    const route = cleanRoute(input.route) ?? existing?.route ?? autoSecretRoute(input.kind, `${label} ${description}`);
    const tags = cleanTags(input.tags) ?? (existing ? json<string[]>(existing.tags ?? '[]', []) : []);
    if (form) this.teach(id, input.kind, form.stored);
    const safe = (text: string) => this.redact(input.value ? text.split(input.value).join(`secret://${id}`) : text);
    if (existing) {
      db.run(`UPDATE secrets SET label = ?, kind = ?, cipher = ?, hint = ?, domains = '[]', description = ?, source = ?, route = ?, tags = ? WHERE id = ?`,
        [safe(label), input.kind, cipher, hint, safe(description), source, route, toJson(tags.map(safe)), id]);
    } else {
      db.run(`INSERT INTO secrets (id, label, kind, cipher, hint, agents, domains, created_at, description, conversation_id, created_by, source, route, tags) VALUES (?, ?, ?, ?, ?, '["*"]', '[]', ?, ?, ?, ?, ?, ?, ?)`,
        [id, safe(label), input.kind, cipher, hint, this.options.clock.now(), safe(description), input.conversationId ?? null, input.createdBy ?? null, source, route, toJson(tags.map(safe))]);
    }
    this.changed(id);
    return toInfo(db.get<SecretRow>('SELECT * FROM secrets WHERE id = ?', [id])!);
  }

  /** X05: the groups (metadata only). */
  groups(): SecretGroup[] {
    return groupList(this.options.db).map(toGroup);
  }

  /** X05: creates or edits a group and its fields – every field is checked before anything is encrypted or written (groups.ts). `createdBy`: the agent creating it. */
  async saveGroup(input: SecretGroupInput, options: { createdBy?: string } = {}): Promise<SecretGroupSaved> {
    const now = this.options.clock.now();
    // A known value in the name or purpose (typed, a file edit) is stored as its handle, like save().
    const text = {
      ...(input.label !== undefined ? { label: this.redact(input.label) } : {}), ...(input.description !== undefined ? { description: this.redact(input.description) } : {}),
      ...(input.tags !== undefined ? { tags: input.tags.map((tag) => this.redact(String(tag ?? ''))) } : {}),
    };
    const plan = planGroup(this.options.db, { ...input, ...text }, now, options.createdBy);
    const ciphers = new Map<string, Uint8Array>();
    for (const field of plan.fields) if (field.stored !== undefined) ciphers.set(field.id, await this.options.host.encrypt(field.stored));
    writeGroup(this.options.db, plan, ciphers, now);
    for (const id of plan.remove) this.redactor.remove(id);
    for (const field of plan.fields) if (field.stored !== undefined) this.teach(field.id, field.kind, field.stored);
    this.options.log?.info('secret group saved', { id: plan.id, fields: plan.fields.length, removed: plan.remove.length }); // never a value
    const group = groupRow(this.options.db, plan.id)!;
    this.changed(plan.id, ...plan.fields.map((field) => field.id)); // a single secret moved in loses its own file
    return { group: toGroup(group), fields: fieldRows(this.options.db, plan.id).map((row) => toInfo(row, group)) };
  }

  /** X05: deletes a group, its fields and their redaction. */
  removeGroup(id: string): void {
    for (const field of deleteGroup(this.options.db, id)) this.redactor.remove(field);
    this.changed(id);
  }

  remove(id: string): void {
    this.options.db.run('DELETE FROM secrets WHERE id = ?', [id]);
    this.redactor.remove(id);
    this.changed(id);
  }

  /** Decrypts for one use – a secret works on every site, in every command and header. `domain` (where it goes) is only logged. */
  async use(id: string, agentId: string, domain?: string): Promise<string> {
    const found = this.find(id);
    if (!found) throw new WorkforceError('not_found', 'Secret not found.');
    const { row, group } = found;
    const name = group ? `${row.field ?? 'field'}' of '${group.label}` : row.label;
    if (!row.cipher) throw new WorkforceError('bad_request', `The secret '${name}' has no stored value.`);
    const now = this.options.clock.now();
    const value = await this.options.host.decrypt(row.cipher);
    this.options.db.run('UPDATE secrets SET last_used_at = ? WHERE id = ?', [now, id]);
    if (group) this.options.db.run('UPDATE secret_groups SET last_used_at = ? WHERE id = ?', [now, group.id]);
    this.teach(id, row.kind, value);
    this.options.log?.info('secret used', { id, agentId, domain }); // never the value (nor a code)
    return row.kind === 'totp' ? this.code(value, now) : value;
  }

  /**
   * A new random password, saved from `site`'s registrable domain (its source and a usage tag – no binding, it works
   * everywhere); the value never leaves the vault. X05: with `username` a new login (username + password), with `groupId`
   * into a stored login (groups.ts generatedLogin) – the password field is returned. What it creates is recorded as the agent's.
   */
  async generate(input: Parameters<SecretService['generate']>[0]): Promise<SecretInfo> {
    // Review intent #9: a password for a server, database or app needs no web site – `site` is then just its source.
    const site = input.site?.trim().slice(0, 200) || undefined;
    const domain = site ? registrableDomain(site) : undefined;
    const source = domain ?? site;
    const value = generatePassword(input.length, input.symbols);
    if (input.username === undefined && input.groupId === undefined) {
      return this.save({ label: input.label, kind: 'password', value, ...(source ? { source } : {}), tags: domain ? [`for the web at ${domain}`] : [], createdBy: input.agentId });
    }
    const plan = generatedLogin(this.options.db, input, domain, value, source);
    const saved = await this.saveGroup(plan, { createdBy: input.agentId });
    return saved.fields.find((info) => info.field === 'password')!;
  }

  redact(text: string): string {
    return this.redactor.redact(text);
  }

  /** The secrets that hold exactly `value` (see the contract): decrypted here, compared, dropped. */
  async holding(value: string, _agentId?: string): Promise<string[]> {
    const ids: string[] = [];
    for (const row of this.options.db.all<SecretRow>("SELECT * FROM secrets WHERE cipher IS NOT NULL AND kind <> 'totp'")) {
      try { if (await this.options.host.decrypt(row.cipher!) === value) ids.push(row.id); } catch { /* unreadable: not a match */ }
    }
    return ids;
  }

  /**
   * 29.10.2026 (password import): the stored logins as keyed prints – the group, its source and an HMAC (a random key
   * that lives only in this process) of its username and password – plus `print` to compare a value against them.
   * 04.11.2026: `values` holds the print of every stored value that is not a 2FA key (what holding() compares), so a .env
   * import checks each pair without decrypting the vault again. Every secret is decrypted once here and the values are
   * dropped; nothing leaves the vault but the prints.
   */
  async loginPrints(): Promise<{ print: (value: string) => string; logins: Array<{ id: string; source?: string; username?: string; password?: string }>; values: Set<string> }> {
    const print = (value: string) => createHmac('sha256', this.printKey).update(value).digest('base64url');
    const logins = new Map<string, { id: string; source?: string; username?: string; password?: string }>();
    for (const group of groupList(this.options.db)) if (group.kind === 'login') logins.set(group.id, { id: group.id, ...(group.source ? { source: group.source } : {}) });
    const values = new Set<string>();
    for (const row of this.options.db.all<SecretRow>("SELECT * FROM secrets WHERE cipher IS NOT NULL AND kind <> 'totp' ORDER BY created_at, rowid")) {
      let printed: string;
      try { printed = print(await this.options.host.decrypt(row.cipher!)); } catch { continue; /* unreadable: not compared */ }
      values.add(printed);
      const login = row.group_id ? logins.get(row.group_id) : undefined;
      if (login && (row.field === 'username' || row.field === 'password')) login[row.field] = printed;
    }
    return { print, logins: [...logins.values()], values };
  }

  private find(id: string): { row: SecretRow; group?: GroupRow } | undefined {
    const row = this.options.db.get<SecretRow>('SELECT * FROM secrets WHERE id = ?', [id]);
    return row ? { row, group: row.group_id ? groupRow(this.options.db, row.group_id) : undefined } : undefined;
  }

  /** The redactor learns a stored value by its kind (groups.ts redactionOf: never a 'text' field, a 2FA key in every spelling). */
  private teach(id: string, kind: string, stored: string): void {
    const forms = redactionOf(kind, stored);
    if (forms) this.redactor.set(id, forms.value, forms.pattern); else this.redactor.remove(id);
  }

  /** The current code of a stored 2FA key; under 3 s left: one wait, then the next window's code. Never logged. */
  private async code(stored: string, now: number): Promise<string> {
    const params = readTotp(stored);
    const current = totpCode(params, now);
    if (current.remainingMs >= MIN_CODE_MS) return current.code;
    await (this.options.sleep ?? defaultSleep)(current.remainingMs);
    return totpCode(params, now + current.remainingMs).code;
  }
}
