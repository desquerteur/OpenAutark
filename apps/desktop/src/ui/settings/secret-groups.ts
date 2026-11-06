// Settings › Secrets – logins, cards and groups of free fields (SecretForm.tsx): the form's fields per kind (login: username,
// password, optional 2FA setup key; card: number, expiry, CVC, holder; a group: free fields), what secrets.saveGroup gets for
// a new or an edited one (an empty value on edit is left out so the stored one stays; removed fields by id), field names as
// the vault takes them, what a list row shows behind its mask and the delete question. Owner 04.11.2026: the Name | Value
// rows (SecretRows.tsx) – one empty row at the end, a pasted .env or JSON split into rows, which rows Add takes –, the
// import's summary line and where each browser exports its passwords (the band's right-click menu).
// Owns: these pure translations. Never: keeps, logs or shows a value, or talks RPC.

import type { MenuSection } from '../lib/popover.tsx';
import { isKeyValueFormat, parseKeyValues } from '../../shared/model/key-values.ts';
import {
  MAX_GROUP_FIELDS, SECRET_GROUP_TEMPLATES, type SecretGroup, type SecretGroupInput, type SecretGroupKind, type SecretImportSummary, type SecretInfo,
} from '../../shared/model/security.ts';

const FORM_LABELS: Record<string, string> = {
  username: 'Username', password: 'Password', totp: '2FA setup key', number: 'Card number', expiry: 'Expiry (MM/YY)', cvc: 'CVC', holder: 'Cardholder',
};

export const TOTP_HINT = 'Optional. The otpauth:// link or the key shown under "enter key manually". Agents then fill the current code.';
export const CVC_HINT = 'Stays encrypted on this PC; agents only get a handle';

/** The kinds a free field may have (a 2FA key at most once per group: the vault checks). */
export const FIELD_KINDS: Array<{ value: SecretInfo['kind']; label: string }> = [
  { value: 'password', label: 'Password' }, { value: 'text', label: 'Text (not secret)' }, { value: 'totp', label: '2FA setup key' },
  { value: 'card', label: 'Card detail' }, { value: 'api_key', label: 'API key' }, { value: 'token', label: 'Token' }, { value: 'note', label: 'Secure note' },
];

export interface FieldDraft {
  /** The stored field's id (an edit); absent for a new field. */
  id?: string;
  field: string;
  kind: SecretInfo['kind'];
  value: string;
  /** From the kind's template (fixed name and type). */
  template?: boolean;
}

export const fieldLabel = (field: string): string => FORM_LABELS[field] ?? field;

/** Typed into a masked input (everything but plain text such as a username or the cardholder). */
export const masked = (kind: SecretInfo['kind']): boolean => kind !== 'text';

/** A field name as the vault takes it: lower-case, a–z 0–9 _ -, starting with a letter, at most 40. */
export function normalizeFieldName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '').replace(/^[^a-z]+/, '').slice(0, 40);
}

/** A group's stored fields in template order (username, password, 2FA …), the rest after them. */
export function fieldsOf(group: Pick<SecretGroup, 'id' | 'kind'>, secrets: readonly SecretInfo[]): SecretInfo[] {
  const order = SECRET_GROUP_TEMPLATES[group.kind].map((entry) => entry.field);
  const rank = (info: SecretInfo) => { const at = order.indexOf(info.field ?? ''); return at < 0 ? order.length : at; };
  return secrets.filter((info) => info.group?.id === group.id).sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
}

/** A new free row; undefined at the limit. */
export function addField(fields: readonly FieldDraft[]): FieldDraft[] | undefined {
  return fields.length >= MAX_GROUP_FIELDS ? undefined : [...fields, { field: '', kind: 'password', value: '' }];
}

/** The form's fields: the kind's template (stored values marked by id) plus the group's other stored fields; a new free group starts with one row. */
export function draftFields(kind: SecretGroupKind, stored: readonly SecretInfo[] = []): FieldDraft[] {
  const template: FieldDraft[] = SECRET_GROUP_TEMPLATES[kind].map((entry) => {
    const found = stored.find((info) => info.field === entry.field);
    return { ...(found ? { id: found.id } : {}), field: entry.field, kind: found?.kind ?? entry.kind, value: '', template: true };
  });
  const rest = stored.filter((info) => !template.some((entry) => entry.field === info.field))
    .map((info): FieldDraft => ({ id: info.id, field: info.field ?? '', kind: info.kind, value: '' }));
  const fields = [...template, ...rest];
  return fields.length ? fields : addField(fields)!;
}

export interface GroupDraft {
  kind: SecretGroupKind;
  label: string;
  description: string;
  fields: FieldDraft[];
  /** Stored field ids to delete on save. */
  removed: string[];
}

/**
 * The secrets.saveGroup params. `id`: an edit of that group, or the entry of a route file that has no value yet (then
 * `route` keeps its place in the catalog). Only fields with a value are sent: an empty input keeps a stored value, an empty
 * template field (the optional 2FA key) is simply not created.
 */
export function groupPayload(draft: GroupDraft, target?: { id: string; stored: boolean; route?: string }): SecretGroupInput {
  const fields = draft.fields
    .filter((field) => field.value !== '' && !(field.id && draft.removed.includes(field.id)))
    .map((field) => ({ ...(field.id ? { id: field.id } : {}), field: normalizeFieldName(field.field), kind: field.kind, value: field.value }))
    .filter((field) => field.field !== '');
  return {
    ...(target ? { id: target.id } : {}),
    ...(target?.stored ? {} : { kind: draft.kind }),
    label: draft.label.trim(),
    description: draft.description.trim(),
    fields,
    ...(target?.route ? { route: target.route } : {}),
    ...(target?.stored && draft.removed.length ? { remove: [...draft.removed] } : {}),
  };
}

/** Why Save waits ('' = it may save): a name, a name for every field with a value (it would be dropped), and on create at least one value. */
export function groupBlocked(draft: GroupDraft, editing: boolean): string {
  if (!draft.label.trim()) return 'Enter a name to save';
  if (draft.fields.some((field) => field.value !== '' && normalizeFieldName(field.field) === '')) return 'Name each field that has a value';
  if (!editing && !draft.fields.some((field) => field.value !== '' && normalizeFieldName(field.field) !== '')) return 'Enter a value to save';
  return '';
}

/** The delete question: "Its 3 fields go with it. Agents using it lose access." */
export function deleteGroupText(fields: number): string {
  return `Its ${fields} ${fields === 1 ? 'field goes' : 'fields go'} with it. Agents using it lose access.`;
}

// ------------------------------------------------------------------ owner 04.11.2026: Name | Value rows (SecretRows.tsx)

/** One row of the band; its id keys the row and is the chat capture's request id. */
export interface KvRow { id: string; name: string; value: string }

const blank = (row: KvRow): boolean => !row.name && !row.value;

/** The rows with exactly one empty row at the end (`fresh` makes one when there is none). */
export function withEmptyRow(rows: readonly KvRow[], fresh: () => KvRow): KvRow[] {
  let end = rows.length;
  while (end > 0 && blank(rows[end - 1])) end--;
  return [...rows.slice(0, end), end < rows.length ? rows[end] : fresh()];
}

/**
 * The rows after pasting `text` into row `index`: .env lines or a JSON object (shared/model/key-values.ts) become rows –
 * in Name any of them, in Value two or more (a single value may hold "="). An empty row is replaced, a filled one stays
 * with the new rows after it. Undefined: a plain paste.
 */
export function pastedRows(rows: readonly KvRow[], index: number, field: 'name' | 'value', text: string, fresh: () => KvRow): KvRow[] | undefined {
  const pairs = parseKeyValues(text);
  if (!pairs || (field === 'value' && pairs.length < 2)) return undefined;
  const added = pairs.map((pair) => ({ ...fresh(), name: pair.name, value: pair.value }));
  const keep = rows[index] && !blank(rows[index]) ? 1 : 0;
  return withEmptyRow([...rows.slice(0, index + keep), ...added, ...rows.slice(index + 1)], fresh);
}

/** The rows Add or Attach takes – those with a value – and why it waits ('' = ready); `named`: each value needs a name. */
export function readyRows(rows: readonly KvRow[], named: boolean): { ready: KvRow[]; blocked: string } {
  const ready = rows.filter((row) => row.value.trim() !== '');
  if (!ready.length) return { ready, blocked: named ? 'Enter a name and a value' : 'Enter the value' };
  if (named && ready.some((row) => !row.name.trim())) return { ready, blocked: 'Give every value a name' };
  return { ready, blocked: '' };
}

/** Where each browser or manager exports its passwords (an export goes in with Choose file… or a drop). */
export const EXPORT_SOURCES: ReadonlyArray<[string, string]> = [
  ['Chrome, Brave, Opera, Vivaldi', 'chrome://password-manager/settings › Export passwords'],
  ['Edge', 'edge://wallet/passwords › Settings › Export passwords'],
  ['Firefox', 'about:logins › ⋯ › Export passwords'],
  ['Safari', 'File › Export › Passwords'],
  ['Password managers', 'Bitwarden, 1Password, KeePass, LastPass, Dashlane, Proton Pass, NordPass: export as CSV (Bitwarden also JSON)'],
];

/** The band's line while nothing happened yet (two lines at phone width; the sources are its right-click menu). */
export const BAND_HINT = 'Paste a .env into Name to split it, or drop a .env, a JSON or a password export here. Right-click: where each browser exports.';

/** The band's right-click menu: every source with its whole path; a row whose path starts at an address (chrome://…, about:logins) copies it. */
export function exportMenu(copy: (address: string) => void): MenuSection[] {
  return [{
    title: 'Where to export passwords',
    items: EXPORT_SOURCES.map(([from, where]) => {
      const address = /^[a-z]+:\S+/.exec(where)?.[0];
      return { label: from, description: where, ...(address ? { hint: 'Copy' } : {}), onSelect: () => { if (address) copy(address); } };
    }),
  }];
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The summary line of an import (counts only); after a password export, that the file can go. */
export function importLine(result: SecretImportSummary): string {
  const parts = [
    result.added ? plural(result.added, 'login added', 'logins added') : '',
    result.cards ? plural(result.cards, 'card added', 'cards added') : '',
    result.keys ? plural(result.keys, 'secret added', 'secrets added') : '',
    result.differing ? `${result.differing} differ from stored ones` : '',
    result.unchanged ? `${result.unchanged} already stored` : '',
    result.skipped ? `${result.skipped} skipped` : '',
    result.failed ? `${result.failed} not readable` : '',
  ].filter(Boolean);
  const review = result.reviewer ? ` ${result.reviewer} now names, describes and checks them.` : '';
  // only a known manager's export that came in completely may go (the agent tool deletes exactly those, tools/builtin/secrets.ts)
  const complete = !result.failed && !result.skipped && result.format !== 'a password export';
  const file = isKeyValueFormat(result.format) || !complete ? '' : ' The export file can go now: it holds every password in plain text.';
  return `${parts.join(' · ') || 'Nothing new'} (${result.format}).${review}${file}`;
}
