// Grouped secrets (X05) for the vault (service.ts): a login or card is a `secret_groups` row and
// each field a `secrets` row with its own handle; for a grouped row the GROUP's route, tags and source
// count (the row's own columns stay '[]' / NULL). Here: the rows and their SecretInfo/SecretGroup shape, the checks
// of secrets.saveGroup before anything is written (names, kinds, <= 20 fields, <= 1 2FA key, values <= 4096 characters,
// a 2FA key that parses, a route name, <= 12 tags), the write in one transaction, the hints and what the leak redactor
// learns per kind. Owner 29.10.2026 (secrets as a catalog like skills, with its Nachtrag):
// the store is a catalog like a skill with ZERO restrictions – no site binding for anything, card data included; the
// site a value came from is its `source` (provenance only), the route its catalog area, the tags information only.
// `created_by` names the agent that created a group or single secret (information only); every agent uses and
// changes every entry. The `agents` columns are no longer read (every entry is for every agent).
// Owns: that SQL and those rules. Never: encrypts, decrypts, logs or returns a value (the vault
// does the crypto; hints show at most the last 4 card digits – and a text field, which is no secret, itself: owner
// 04.11.2026, he wants to see which email belongs to an entry).

import type { Db } from '../db/database.ts';
import { json, toJson } from '../db/database.ts';
import {
  autoSecretRoute, MAX_GROUP_FIELDS, MAX_SECRET_TAG, MAX_SECRET_TAGS, SECRET_FIELD_NAME, SECRET_ROUTE,
  type SecretGroup, type SecretGroupInput, type SecretGroupKind, type SecretInfo,
} from '../../shared/model/security.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { newId } from '../../shared/ids.ts';
import { parseTotp, readTotp, seedPattern, serializeTotp, type TotpParams } from './totp.ts';

export const SECRET_KINDS: readonly SecretInfo['kind'][] = ['api_key', 'password', 'card', 'token', 'note', 'totp', 'text'];
const GROUP_KINDS: readonly SecretGroupKind[] = ['login', 'card', 'other'];
export const MAX_FIELD_VALUE = 4096;

export interface SecretRow {
  description?: string; conversation_id?: string | null;
  id: string; label: string; kind: string; cipher: Uint8Array | null; hint: string | null; agents: string;
  domains: string; created_at: number; last_used_at: number | null; group_id?: string | null; field?: string | null; created_by?: string | null;
  source?: string | null; route?: string | null; tags?: string | null;
}

export interface GroupRow {
  id: string; label: string; kind: SecretGroupKind; description: string | null; agents: string; domains: string;
  created_at: number; last_used_at: number | null; created_by?: string | null; source?: string | null; route?: string | null; tags?: string | null;
}

const bad = (message: string): never => { throw new WorkforceError('bad_request', message); };
const clip = (value: string, max = 40) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** The route of an entry: the stored one, else what autoSecretRoute picks (a row from before migration 81). */
const routeOf = (scope: { route?: string | null; kind: string; label: string; description?: string | null }, groupKind?: string) =>
  scope.route || autoSecretRoute(scope.kind, `${scope.label} ${scope.description ?? ''}`, groupKind);

/** A row as the UI and the tools see it: a grouped row carries its group and the group's route, tags and source. */
export function toInfo(row: SecretRow, group?: GroupRow): SecretInfo {
  const scope = group ?? row;
  const tags = json<string[]>(scope.tags ?? '[]', []);
  const info: SecretInfo = {
    id: row.id, label: row.label, kind: row.kind as SecretInfo['kind'], hint: row.hint ?? undefined,
    route: group ? routeOf(group, group.kind) : routeOf(row),
    createdAt: row.created_at, lastUsedAt: row.last_used_at ?? undefined,
  };
  if (tags.length) info.tags = tags;
  if (row.description) info.description = row.description;
  if (row.conversation_id) info.conversationId = row.conversation_id;
  if (row.created_by) info.createdBy = row.created_by;
  if (scope.source) info.source = scope.source;
  if (group) Object.assign(info, { group: { id: group.id, label: group.label, kind: group.kind }, field: row.field ?? undefined });
  return info;
}

export function toGroup(row: GroupRow): SecretGroup {
  const tags = json<string[]>(row.tags ?? '[]', []);
  const group: SecretGroup = { id: row.id, label: row.label, kind: row.kind, route: routeOf(row, row.kind), createdAt: row.created_at };
  if (row.description) group.description = row.description;
  if (tags.length) group.tags = tags;
  if (row.last_used_at !== null) group.lastUsedAt = row.last_used_at;
  if (row.created_by) group.createdBy = row.created_by;
  if (row.source) group.source = row.source;
  return group;
}

/** A route name as stored (lower-case slug, checked); throws bad_request for one that cannot name a file. */
export function cleanRoute(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const route = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!route) return undefined;
  if (!SECRET_ROUTE.test(route) || route.endsWith('-rejected')) bad(`"${clip(value)}" is no route name (lower-case letters, digits and "-", at most 40).`);
  return route;
}

/** Tags as stored: one line each, no duplicates, at most MAX_SECRET_TAGS of at most MAX_SECRET_TAG characters. */
export function cleanTags(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  const out: string[] = [];
  for (const value of values) {
    const tag = String(value ?? '').replace(/\s+/g, ' ').replace(/;/g, ',').trim(); // ';' separates tags in the route files
    if (!tag) continue;
    if (tag.length > MAX_SECRET_TAG) bad(`A tag has at most ${MAX_SECRET_TAG} characters.`);
    if (!out.some((seen) => seen.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  if (out.length > MAX_SECRET_TAGS) bad(`An entry has at most ${MAX_SECRET_TAGS} tags.`);
  return out;
}

export const groupRow = (db: Db, id: string) => db.get<GroupRow>('SELECT * FROM secret_groups WHERE id = ?', [id]);
export const groupList = (db: Db) => db.all<GroupRow>('SELECT * FROM secret_groups ORDER BY label COLLATE NOCASE, id');
export const fieldRows = (db: Db, groupId: string) => db.all<SecretRow>('SELECT * FROM secrets WHERE group_id = ? ORDER BY created_at, rowid', [groupId]);

const DIGITS_ONLY = (value: string) => value.replace(/\D/g, '');

export function totpHint(params: Pick<TotpParams, 'digits' | 'period' | 'algorithm'>): string {
  return `${params.digits} digits · ${params.period} s${params.algorithm === 'SHA1' ? '' : ` · ${params.algorithm}`}`;
}

/** A text field's hint: the text itself on one line, clipped to 60 characters ("max@firma.de"). */
export const textHint = (value: string): string | undefined => {
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? clip(text, 60) : undefined;
};

/**
 * What is encrypted for a typed value (a 2FA key as canonical JSON; throws bad_request when it does
 * not parse) and its hint: "•••• 1234" for a single card or a group's `number`, the code format for
 * a 2FA key, the text itself for text (textHint).
 */
export function storedForm(kind: string, value: string, field?: string): { stored: string; hint?: string } {
  if (kind === 'totp') {
    const params = parseTotp(value);
    return { stored: serializeTotp(params), hint: totpHint(params) };
  }
  if (kind === 'card' && (field === undefined || field === 'number')) return { stored: value, hint: `•••• ${DIGITS_ONLY(value).slice(-4)}` };
  if (kind === 'text') return { stored: value, hint: textHint(value) };
  return { stored: value };
}

/** What the leak redactor learns from a stored value: never a text field (it shows on pages), a 2FA key in every spelling, never its JSON. */
export function redactionOf(kind: string, stored: string): { value?: string; pattern?: RegExp } | undefined {
  if (kind === 'text') return undefined;
  if (kind !== 'totp') return { value: stored };
  try { return { pattern: seedPattern(readTotp(stored)) }; } catch { return undefined; }
}

interface FieldPlan { id: string; field: string; kind: string; existing: boolean; stored?: string; hint?: string }

export interface GroupPlan {
  id: string;
  create: boolean;
  label: string;
  kind: SecretGroupKind;
  description: string | null;
  route: string;
  tags: string[];
  fields: FieldPlan[];
  remove: string[];
  /** The agent that creates the group (secrets.generate, browser.save_totp); null for the person. Kept on edits. */
  createdBy: string | null;
  /** The site it comes from (provenance); a stored one is kept unless the app gives a new one. */
  source: string | null;
}

/** Every check of secrets.saveGroup, before anything is encrypted or written (see the header). */
export function planGroup(db: Db, input: SecretGroupInput, now: number, createdBy?: string): GroupPlan {
  const existing = input.id ? groupRow(db, input.id) : undefined;
  if (existing && input.kind !== undefined && input.kind !== existing.kind) bad('The kind of a group is fixed after creation.');
  const kind = existing?.kind ?? input.kind ?? 'other';
  if (!GROUP_KINDS.includes(kind)) bad('A group is a login, a card or another kind of group.');
  const label = (input.label ?? existing?.label ?? '').trim();
  if (!label || label.length > 120) bad('A group needs a name of at most 120 characters.');
  const description = input.description !== undefined ? input.description.trim() || null : existing?.description ?? null;
  if (description && description.length > 500) bad('The description has at most 500 characters.');
  const stored = existing ? fieldRows(db, existing.id) : [];
  const remove = [...new Set(input.remove ?? [])];
  if (remove.some((id) => !stored.some((row) => row.id === id))) bad('Only fields of this group can be removed.');
  const kept = stored.filter((row) => !remove.includes(row.id));
  const fields: FieldPlan[] = [];
  for (const entry of input.fields ?? []) {
    const name = typeof entry?.field === 'string' ? entry.field.trim() : '';
    if (!SECRET_FIELD_NAME.test(name)) bad(`Field names start with a lower-case letter and use a–z, 0–9, "_" or "-" (at most 40): "${clip(name)}".`);
    if (!SECRET_KINDS.includes(entry.kind)) bad(`Unknown type for the field "${name}".`);
    const target = entry.id ? kept.find((row) => row.id === entry.id) ?? adoptable(db, entry.id) : kept.find((row) => row.field === name);
    if (entry.id && !target && db.get('SELECT id FROM secrets WHERE id = ?', [entry.id])) bad(`The field "${name}" belongs to another group.`);
    if (target && target.kind !== entry.kind) bad(`The type of the field "${name}" is fixed.`);
    const value = entry.value ?? '';
    if (typeof value !== 'string' || value.length > MAX_FIELD_VALUE) bad(`"${name}" must be text of at most ${MAX_FIELD_VALUE} characters.`);
    if (!target && !value) bad(`The new field "${name}" needs a value.`);
    let form: ReturnType<typeof storedForm> | undefined;
    try { form = value ? storedForm(entry.kind, value, name) : undefined; } catch (error) { bad(`"${name}": ${(error as Error).message}`); }
    if (fields.some((plan) => plan.id === (target?.id ?? entry.id))) bad(`The field "${name}" is listed twice.`);
    fields.push({ id: target?.id ?? entry.id ?? newId('sec', now), field: name, kind: entry.kind, existing: Boolean(target), ...form });
  }
  const final = new Map<string, { field: string; kind: string }>(kept.map((row) => [row.id, { field: row.field ?? '', kind: row.kind }]));
  for (const plan of fields) final.set(plan.id, { field: plan.field, kind: plan.kind });
  const names = [...final.values()].map((entry) => entry.field);
  const twice = names.find((name, index) => names.indexOf(name) !== index);
  if (twice !== undefined) bad(`Two fields are named "${clip(twice)}".`);
  if (final.size > MAX_GROUP_FIELDS) bad(`A group has at most ${MAX_GROUP_FIELDS} fields.`);
  if ([...final.values()].filter((entry) => entry.kind === 'totp').length > 1) bad('A group holds at most one 2FA setup key.');
  if (!existing && !final.size) bad('A group needs at least one field.');
  const money = kind === 'card' || [...final.values()].some((entry) => entry.kind === 'card');
  const route = cleanRoute(input.route) ?? existing?.route ?? autoSecretRoute(kind, `${label} ${description ?? ''}`, money ? 'card' : kind);
  return {
    id: existing?.id ?? input.id ?? `sgr_${newId('sec', now).slice(4)}`, create: !existing, label, kind, description,
    route, tags: cleanTags(input.tags) ?? (existing ? json<string[]>(existing.tags ?? '[]', []) : []), fields, remove,
    createdBy: existing ? existing.created_by ?? null : createdBy ?? null,
    source: input.source ?? existing?.source ?? null,
  };
}

/** A single secret (no group) that a field id may move into the group. */
function adoptable(db: Db, id: string): SecretRow | undefined {
  return db.get<SecretRow>('SELECT * FROM secrets WHERE id = ? AND group_id IS NULL', [id]);
}

/** Writes a checked plan with its ciphers (by field id) in one transaction. */
export function writeGroup(db: Db, plan: GroupPlan, ciphers: ReadonlyMap<string, Uint8Array>, now: number): void {
  db.tx(() => {
    if (plan.create) {
      db.run(`INSERT INTO secret_groups (id, label, kind, description, agents, domains, created_at, created_by, source, route, tags) VALUES (?, ?, ?, ?, '["*"]', '[]', ?, ?, ?, ?, ?)`,
        [plan.id, plan.label, plan.kind, plan.description, now, plan.createdBy, plan.source, plan.route, toJson(plan.tags)]);
    } else {
      db.run(`UPDATE secret_groups SET label = ?, description = ?, domains = '[]', source = ?, route = ?, tags = ? WHERE id = ?`,
        [plan.label, plan.description, plan.source, plan.route, toJson(plan.tags), plan.id]);
    }
    for (const id of plan.remove) db.run('DELETE FROM secrets WHERE id = ? AND group_id = ?', [id, plan.id]);
    for (const field of plan.fields) {
      const label = `${plan.label} · ${field.field}`.slice(0, 120);
      const cipher = ciphers.get(field.id) ?? null;
      if (field.existing) {
        db.run(`UPDATE secrets SET label = ?, cipher = COALESCE(?, cipher), hint = CASE WHEN ? IS NULL THEN hint ELSE ? END, agents = '[]', domains = '[]', route = NULL, tags = '[]', group_id = ?, field = ? WHERE id = ?`,
          [label, cipher, cipher, field.hint ?? null, plan.id, field.field, field.id]);
      } else {
        db.run(`INSERT INTO secrets (id, label, kind, cipher, hint, agents, domains, created_at, group_id, field) VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?)`,
          [field.id, label, field.kind, cipher, field.hint ?? null, now, plan.id, field.field]);
      }
    }
    for (const row of fieldRows(db, plan.id)) db.run('UPDATE secrets SET label = ? WHERE id = ?', [`${plan.label} · ${row.field ?? ''}`.slice(0, 120), row.id]);
  });
}

/** Deletes a group with its fields; returns the field ids (their redaction is forgotten by the vault). */
export function deleteGroup(db: Db, id: string): string[] {
  return db.tx(() => {
    const ids = fieldRows(db, id).map((row) => row.id);
    db.run('DELETE FROM secrets WHERE group_id = ?', [id]);
    db.run('DELETE FROM secret_groups WHERE id = ?', [id]);
    return ids;
  });
}

/**
 * secrets.generate into a login (`groupId`) or a new one (`username`); an existing password or username is replaced only
 * with `replace`. `domain` becomes the login's source and a usage tag, never a restriction.
 */
export function generatedLogin(
  db: Db, input: { label: string; username?: string; groupId?: string; replace?: boolean },
  domain: string | undefined, password: string, source = domain,
): SecretGroupInput {
  const fields: NonNullable<SecretGroupInput['fields']> = [{ field: 'password', kind: 'password', value: password }];
  if (input.username !== undefined) {
    if (!input.username.trim()) bad('Give the username (or email) of the login.');
    fields.unshift({ field: 'username', kind: 'text', value: input.username.trim() });
  }
  if (input.groupId === undefined) return { label: input.label, kind: 'login', ...(source ? { source } : {}), tags: domain ? [`for the web at ${domain}`] : [], fields };
  const group = groupRow(db, input.groupId);
  if (!group) throw new WorkforceError('not_found', 'No stored login with that id (secrets.list shows them).');
  if (group.kind === 'card') bad(`"${group.label}" is a card, not a login.`);
  const stored = fieldRows(db, group.id);
  if (!input.replace && stored.some((row) => row.kind === 'password')) {
    throw new WorkforceError('conflict', `"${group.label}" already has a password. Pass replace:true to change it (the old one stops working once the site has the new one).`);
  }
  if (!input.replace && input.username !== undefined && stored.some((row) => row.field === 'username')) {
    throw new WorkforceError('conflict', `"${group.label}" already has a username. Leave out username, or pass replace:true to change it.`);
  }
  return { id: group.id, ...(group.source || !source ? {} : { source }), fields };
}
