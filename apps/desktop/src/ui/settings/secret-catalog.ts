// Settings › Secrets – the catalog's list and its selection (SecretsPage.tsx): the entries in list order (singles, logins
// and cards, files without a value; grouped by route), each row's line and what it shows where a value would be (a
// login's username, a card's last digits – the hints the vault keeps). Owner 04.11.2026 ("grundsätzlich alle selected …
// einzelne ab- und anwählen … löschen oder exportieren"): every entry is selected unless the person deselected it, so a new
// entry starts selected; All clears that set, None fills it; Export takes the selected entries that hold a value
// (secrets.export), Delete removes each selected one (secrets.delete, a login or card with secrets.deleteGroup).
// B-075: an entry the app itself works with (usedByApp: an account's key, a bridge, a calendar) starts unselected and
// is selected only by its own box – All and None leave it as it is, so a bulk Delete keeps the app working; its line
// says "Used by the app".
// Owns: these pure translations. Never: keeps, logs or shows a value, or talks RPC itself (the page passes the call).

import { SYSTEM_ID } from '../../shared/ids.ts';
import { SECRET_ROUTES, type SecretExportSummary, type SecretFileEntry, type SecretGroup, type SecretInfo } from '../../shared/model/security.ts';
import { fieldsOf } from './secret-groups.ts';

const ROUTE_LABELS: Record<string, string> = { logins: 'Logins', payment: 'Payment', keys: 'Keys and tokens', servers: 'Servers', notes: 'Notes' };
const KIND_LABELS: Record<string, string> = {
  password: 'Password', card: 'Payment card', api_key: 'API key', token: 'Token', note: 'Secure note', totp: '2FA setup key', text: 'Text', login: 'Login', other: 'Group',
};

export const routeLabel = (route: string) => ROUTE_LABELS[route] ?? `${route.charAt(0).toUpperCase()}${route.slice(1).replace(/-/g, ' ')}`;
/** The routes in list order: the standard ones first, then the others by name. */
const routeOrder = (route: string) => { const at = (SECRET_ROUTES as readonly string[]).indexOf(route); return at < 0 ? `9${route}` : `${at}`; };

export type CatalogEntry =
  | { type: 'single'; id: string; name: string; route: string; info: SecretInfo }
  | { type: 'group'; id: string; name: string; route: string; group: SecretGroup }
  | { type: 'missing'; id: string; name: string; route: string; file: SecretFileEntry };

/** The catalog in list order (pure). A secret the app keeps for itself (createdBy SYSTEM_ID) is not listed. */
export function catalogEntries(secrets: readonly SecretInfo[], groups: readonly SecretGroup[], missing: readonly SecretFileEntry[]): CatalogEntry[] {
  return [
    ...secrets.filter((secret) => !secret.group && secret.createdBy !== SYSTEM_ID).map((info): CatalogEntry => ({ type: 'single', id: info.id, name: info.label, route: info.route ?? 'notes', info })),
    ...groups.map((group): CatalogEntry => ({ type: 'group', id: group.id, name: group.label, route: group.route ?? 'notes', group })),
    ...missing.map((file): CatalogEntry => ({ type: 'missing', id: file.id, name: file.name, route: file.route, file })),
  ].sort((a, b) => routeOrder(a.route).localeCompare(routeOrder(b.route)) || a.name.localeCompare(b.name));
}

/** A row's line: purpose · kind · tags · Value missing · Saved from … */
export function entryLine(entry: CatalogEntry): string {
  const source = entry.type === 'single' ? entry.info : entry.type === 'group' ? entry.group : entry.file;
  const purpose = (entry.type === 'missing' ? entry.file.purpose : (source as SecretInfo | SecretGroup).description)?.split('\n')[0].trim();
  const from = entry.type === 'missing' ? undefined : (source as SecretInfo | SecretGroup).source; // provenance only: it works everywhere
  return [purpose, KIND_LABELS[source.kind] ?? source.kind, source.tags?.join(', '), entry.type === 'missing' ? 'Value missing' : undefined, usedByApp(entry) ? 'Used by the app' : undefined, from && `Saved from ${from}`].filter(Boolean).join(' · ');
}

/** The app itself works with this entry (an account's key, a bridge, a calendar). */
export const usedByApp = (entry: CatalogEntry): boolean => entry.type === 'single' ? Boolean(entry.info.usedByApp) : entry.type === 'group' ? Boolean(entry.group.usedByApp) : false;

/** What a row shows where its value would be: a single secret's hint, a login's username, a card's last digits (undefined: the mask). */
export function shownHint(entry: CatalogEntry, secrets: readonly SecretInfo[]): string | undefined {
  if (entry.type === 'single') return entry.info.hint;
  if (entry.type === 'missing') return undefined;
  return fieldsOf(entry.group, secrets).find((info) => (info.field === 'username' || info.field === 'number') && info.hint)?.hint;
}

/** Whether an entry is selected: `flipped` holds the boxes the person changed from the start (all selected, the app's own not). */
export const isSelected = (entry: CatalogEntry, flipped: ReadonlySet<string>): boolean => usedByApp(entry) ? flipped.has(entry.id) : !flipped.has(entry.id);

/** The selected entries. */
export const selectedEntries = (entries: readonly CatalogEntry[], flipped: ReadonlySet<string>): CatalogEntry[] => entries.filter((entry) => isSelected(entry, flipped));

/** The changed boxes after a click on one entry's box. */
export function toggled(deselected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(deselected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/** None: every listed entry deselected (All is the empty set: everything but the app's own). */
export const noneSelected = (entries: readonly CatalogEntry[]): Set<string> => new Set(entries.filter((entry) => !usedByApp(entry)).map((entry) => entry.id));

/** The ids secrets.export takes: the selected entries that hold a value (a file without one has nothing to export). */
export const exportIds = (selected: readonly CatalogEntry[]): string[] => selected.filter((entry) => entry.type !== 'missing').map((entry) => entry.id);

/** The question before Delete removes the selected entries. */
export function deleteQuestion(count: number): { title: string; body: string } {
  return { title: `Delete ${count} ${count === 1 ? 'entry' : 'entries'}?`, body: 'Agents using them lose access; your linked PCs remove them too.' };
}

/** Deletes each entry with `call` (one after the other); how many went and the first error ('' when none). */
export async function deleteEntries(
  entries: readonly CatalogEntry[], call: (method: 'secrets.delete' | 'secrets.deleteGroup', id: string) => Promise<unknown>, errorText: (error: unknown) => string,
): Promise<{ deleted: number; failure: string }> {
  let deleted = 0;
  let failure = '';
  for (const entry of entries) {
    try {
      await call(entry.type === 'group' ? 'secrets.deleteGroup' : 'secrets.delete', entry.id);
      deleted++;
    } catch (error) { failure ||= errorText(error); }
  }
  return { deleted, failure };
}

/** The toast after an export: how many went where, and that the file holds the values in plain text. */
export function exportNote(result: SecretExportSummary): { title: string; body: string } {
  const skipped = result.skipped ? ` ${result.skipped} skipped (a group of free fields, or a value this PC cannot read).` : '';
  return { title: `${result.count} ${result.count === 1 ? 'entry' : 'entries'} exported`, body: `${result.file} – it holds every value in plain text.${skipped}` };
}
