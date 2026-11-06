// Secrets export (owner 04.11.2026: copy them out as a file "in a format
// that is easy to process and that we can use too", only the selected ones): the chosen entries – all when none are named –
// as one CSV whose header starts like Chrome's (name,url,username,password,note) and goes on with ours (totp, kind,
// description, tags joined with "; ", route and a card's number, expiry, cvc, holder). Browsers and password managers read
// its logins; our import (import-parse.ts) reads every row back with its name, description, tags and route. A login is one
// row (kind login); a single secret a row with its kind and its value under password; a card a row with kind card; a
// login's or card's field without a column (or a second one for the same column) a row of its own, "<name> · <field>" with
// its kind, so no value stays behind. A group of free fields ('other') has no row in this format and counts as skipped,
// like an entry whose value cannot be decrypted here; a named id that is no entry comes back as notFound. A field's id
// names its group; what the app keeps for itself is left out unless named (units.ts catalogUnits). The file: mode 0600,
// by default ~/Downloads/autark-secrets-<date>.csv; a folder given gets that name inside it; a path inside the data
// folder (synced, the agents' workspace) gets the default; a name that is taken gets " (2)" … – nothing is overwritten.
// Owns: the rows and the file. Never: logs a value or returns one – the caller gets the path and the counts.

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import type { SecretExportSummary } from '../../shared/model/security.ts';
import { hostOf } from './service.ts';
import { catalogUnits, readUnit, type SecretUnit } from './units.ts';

export const EXPORT_COLUMNS = ['name', 'url', 'username', 'password', 'note', 'totp', 'kind', 'description', 'tags', 'route', 'number', 'expiry', 'cvc', 'holder'] as const;
type Column = typeof EXPORT_COLUMNS[number];
type ExportRow = Partial<Record<Column, string>>;

/** The fields of a login or card by the column that holds them. */
const FIELD_COLUMNS: Record<string, Partial<Record<string, Column>>> = {
  login: { username: 'username', password: 'password', totp: 'totp', notes: 'note', note: 'note' },
  card: { number: 'number', expiry: 'expiry', cvc: 'cvc', holder: 'holder', notes: 'note', note: 'note' },
};

const cell = (value = '') => `"${value.replace(/"/g, '""')}"`;
const pad = (value: number) => String(value).padStart(2, '0');

/** The site a source names, as a URL a browser matches ('' for a source that is no host, e.g. "the deploy CLI"). */
function urlOf(source: string | undefined): string {
  if (!source) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return source;
  return hostOf(source) ? `https://${source}` : '';
}

/** One unit's rows (see the header); none when the format has no row for it (a group of free fields). */
export function exportRows(unit: SecretUnit, route: string): ExportRow[] {
  const meta: ExportRow = { url: urlOf(unit.source), description: unit.description, tags: unit.tags.join('; '), route: unit.route ?? route };
  if (!unit.group) return unit.value === undefined ? [] : [{ ...meta, name: unit.label, kind: unit.kind, password: unit.value }];
  const columns = FIELD_COLUMNS[unit.kind];
  if (!columns) return [];
  const row: ExportRow = { ...meta, name: unit.label, kind: unit.kind };
  const extra: ExportRow[] = [];
  for (const field of unit.fields ?? []) {
    if (field.value === undefined) continue;
    const column = columns[field.field];
    if (column && row[column] === undefined) row[column] = field.value;
    else extra.push({ ...meta, name: `${unit.label} · ${field.field}`, kind: field.kind, password: field.value });
  }
  return [row, ...extra];
}

/** The CSV of these rows (every cell quoted, "" inside). */
export function exportCsv(rows: readonly ExportRow[]): string {
  return [EXPORT_COLUMNS.join(','), ...rows.map((row) => EXPORT_COLUMNS.map((column) => cell(row[column])).join(','))].join('\n') + '\n';
}

/** `file`, or "<name> (2).csv" … when that name is taken. */
export function freeFile(file: string): string {
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = n > 1 ? `${base} (${n})${ext}` : file;
    if (!existsSync(candidate)) return candidate;
  }
}

/** ~/Downloads/autark-secrets-<local date>.csv, with " (2)" … when that name is taken. */
export function defaultExportFile(now: number, dir = path.join(os.homedir(), 'Downloads')): string {
  const day = new Date(now);
  return freeFile(path.join(dir, `autark-secrets-${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}.csv`));
}

/** True when `file` is `dir` or lies inside it. */
const inside = (dir: string | undefined, file: string) => {
  if (!dir) return false;
  const relative = path.relative(path.resolve(dir), file);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
};

/** The file to write: the default, a free name in a given folder, or the given file under a free name (see the header). */
function targetFile(given: string | undefined, now: number, data: string | undefined): string {
  const file = given ? path.resolve(given) : undefined;
  if (!file || inside(data, file)) return defaultExportFile(now);
  return existsSync(file) && statSync(file).isDirectory() ? defaultExportFile(now, file) : freeFile(file);
}

/** Writes the chosen entries (`ids`, else those of `route`, else all) into `file` (default: defaultExportFile) – see the header. */
export async function exportSecrets(
  services: Pick<RuntimeServices, 'db' | 'host' | 'secrets' | 'clock'> & { paths?: Pick<RuntimeServices['paths'], 'data'>; settings?: Pick<RuntimeServices['settings'], 'get'> },
  options: { ids?: readonly string[]; route?: string; file?: string } = {},
): Promise<SecretExportSummary> {
  const db = services.db;
  const routes = new Map<string, string | undefined>([ // the vault's route (one is chosen for an entry stored without)
    ...services.secrets.list().filter((info) => !info.group).map((info) => [info.id, info.route] as const), ...services.secrets.groups().map((group) => [group.id, group.route] as const),
  ]);
  const named = options.ids?.length
    ? [...new Map(options.ids.map((id) => [db.get<{ group_id: string | null }>('SELECT group_id FROM secrets WHERE id = ?', [id])?.group_id ?? id, id])).entries()]
    : catalogUnits(services, options.route).map((unit) => [unit.id, unit.id] as const);
  const rows: ExportRow[] = [];
  const notFound: string[] = [];
  let count = 0;
  let skipped = 0;
  for (const [id, asked] of named) {
    let unit: SecretUnit | undefined;
    try { unit = await readUnit(db, (cipher) => services.host.decrypt(cipher), id); } catch { skipped++; continue; } // a value this PC cannot decrypt
    if (!unit) { notFound.push(asked); continue; }
    const written = exportRows(unit, routes.get(id) ?? 'notes');
    if (written.length) { rows.push(...written); count++; } else skipped++;
  }
  const file = targetFile(options.file, services.clock.now(), services.paths?.data);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, exportCsv(rows), { mode: 0o600, flag: 'wx' }); // 'wx': never over a file that appeared meanwhile
  return { file, count, skipped, ...(notFound.length ? { notFound } : {}) };
}
