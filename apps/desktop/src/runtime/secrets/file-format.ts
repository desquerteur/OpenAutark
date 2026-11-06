// The route files of the secrets catalog (owner 29.10.2026, secrets as a catalog like skills:
// "a catalog like a skill": a few routes, one file per route listing several entries): <data>/secrets/<route>.md –
// front matter `route:` plus a note, then one section per entry:
//   ## <name>
//   - id: <id>                      (the handle is secret://<id>)
//   - kind: <kind>
//   - tags: <tag>; <tag>            (usage tags, information only)
//   - source: <site or tool>        (where the value came from – provenance only)
//   - fields: <field> · <kind> · secret://<id>; …   (a login or card)
//   <description>
// Like a skill: a person, an editor or an AI reads what each entry is for and its handle; the value stays encrypted in
// the vault under the same id and is never in a file. Only the name (heading), the description and the tags are taken
// from a file (files.ts); kind, source and fields are the app's – written for reading; a line the file states
// differently is an edit to ignore (touchesFixed), a line it leaves out is none. A section whose id the vault does not
// know is a "value missing" entry (written by hand or by an AI; its value is stored with secrets.save).
// Before 29.10.2026 every entry had its own file <id>.md (YAML front matter id, name, kind, domains, fields, access and
// the purpose as body): parseLegacyFile reads such a file once so files.ts can move it into its route file.
// Owns: rendering, parsing and the comparison of the fixed part. Never: a value, a hash, a hint or a cipher in the text;
// reads or writes files.

import type { SecretGroup, SecretInfo } from '../../shared/model/security.ts';
import { autoSecretRoute, SECRET_ROUTE } from '../../shared/model/security.ts';
import { parseFrontMatter } from '../skills/frontmatter.ts';

/** Names of the .md files the folder may hold (a route, or a legacy entry id) – also what a backup carries. */
export const FILE_ID = /^[A-Za-z0-9_-]{1,80}$/;
export const FILE_LIMITS = { maxBytes: 256 * 1024, maxChars: 200_000 } as const;
const NOTE = '# The secrets of this route, like a skill index – never a value (values stay encrypted in the app; agents use secret://<id>). Edit a name (## heading), a description or the tags; id, kind, source and fields are set by the app.';

/** What one section says: an entry of the vault (a single secret or a group with its fields). */
export interface SecretEntry {
  id: string;
  name: string;
  purpose: string;
  kind: string;
  route: string;
  tags: string[];
  source?: string;
  /** A group's fields as "<field> · <kind> · secret://<id>"; [] for a single secret. */
  fields: string[];
  group: boolean;
}

export const fileName = (key: string) => `${key}.md`;

/** The key a file name stands for (undefined for other files, e.g. a rejected copy). */
export function idOfFile(name: string): string | undefined {
  const match = /^(.+)\.md$/i.exec(name);
  return match && !/\.rejected$/i.test(match[1]) && FILE_ID.test(match[1]) ? match[1] : undefined;
}

/** The route a file name stands for: <route>.md with a valid route name (undefined for legacy entry files and others). */
export function routeOfFile(name: string): string | undefined {
  const key = idOfFile(name);
  return key !== undefined && SECRET_ROUTE.test(key) ? key : undefined;
}

export function singleEntry(info: SecretInfo): SecretEntry {
  return {
    id: info.id, name: info.label, purpose: info.description ?? '', kind: info.kind, route: info.route ?? autoSecretRoute(info.kind, `${info.label} ${info.description ?? ''}`), tags: [...(info.tags ?? [])],
    ...(info.source ? { source: info.source } : {}), fields: [], group: false,
  };
}

export function groupEntry(group: SecretGroup, fields: readonly SecretInfo[]): SecretEntry {
  return {
    id: group.id, name: group.label, purpose: group.description ?? '', kind: group.kind, route: group.route ?? autoSecretRoute(group.kind, `${group.label} ${group.description ?? ''}`, group.kind), tags: [...(group.tags ?? [])],
    ...(group.source ? { source: group.source } : {}),
    fields: fields.map((field) => `${field.field ?? ''} · ${field.kind} · secret://${field.id}`), group: true,
  };
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const split = (value: string, by: RegExp) => value.split(by).map((part) => part.trim()).filter(Boolean);

/** One entry's section (canonical: LF, no trailing white space). */
function renderEntry(entry: SecretEntry): string {
  const lines = [`## ${oneLine(entry.name) || entry.id}`, `- id: ${entry.id}`, `- kind: ${entry.kind}`];
  if (entry.tags.length) lines.push(`- tags: ${entry.tags.map(oneLine).join('; ')}`);
  if (entry.source) lines.push(`- source: ${oneLine(entry.source)}`);
  if (entry.fields.length) lines.push(`- fields: ${entry.fields.join('; ')}`);
  // A description line that looks like a heading would start a new entry when read back.
  const purpose = entry.purpose.trim().split('\n').map((line) => line.replace(/\s+$/, '').replace(/^(#{1,6}\s)/, ' $1')).join('\n');
  return purpose ? `${lines.join('\n')}\n\n${purpose}` : lines.join('\n');
}

/** The file text of one route (canonical), its entries by name then id. */
export function renderRouteFile(route: string, entries: readonly SecretEntry[]): string {
  const head = ['---', `route: ${route}`, NOTE, '---'].join('\n');
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return sorted.length ? `${head}\n${sorted.map(renderEntry).join('\n\n')}` : head;
}

const FIXED_KEYS = ['kind', 'source', 'fields'] as const;
export type FixedValues = Record<(typeof FIXED_KEYS)[number], string>;

/** The lines only the app sets, each comparable between a file and an entry. */
export function fixedValues(entry: Pick<SecretEntry, 'kind' | 'source' | 'fields'>): FixedValues {
  return { kind: entry.kind, source: oneLine(entry.source ?? ''), fields: JSON.stringify(entry.fields) };
}

export interface ParsedEntry {
  /** undefined when the section names no id (a section without one is not usable). */
  id?: string;
  /** '' when the heading is empty. */
  name: string;
  purpose: string;
  /** undefined when the section has no tags line. */
  tags?: string[];
  kind?: string;
  /** The fixed lines the section states (fixedValues form); a line left out is absent. */
  fixed: Partial<FixedValues>;
}

export interface ParsedRouteFile { route?: string; entries: ParsedEntry[] }

const LINE = /^-\s*(id|kind|tags|source|access|fields)\s*:\s*(.*)$/i;

/** What a route file says (lenient: missing parts read as empty; never throws). */
export function parseRouteFile(text: string): ParsedRouteFile {
  const { data, body } = parseFrontMatter(text);
  const route = typeof data.route === 'string' ? data.route.trim() : undefined;
  const entries: ParsedEntry[] = [];
  let current: { name: string; meta: Map<string, string>; rest: string[]; inMeta: boolean } | undefined;
  const close = () => {
    if (!current) return;
    const meta = current.meta;
    const fixed: Partial<FixedValues> = {};
    if (meta.has('kind')) fixed.kind = meta.get('kind')!;
    if (meta.has('source')) fixed.source = oneLine(meta.get('source')!);
    if (meta.has('fields')) fixed.fields = JSON.stringify(split(meta.get('fields')!, /;/));
    entries.push({
      ...(meta.get('id') ? { id: meta.get('id')!.trim() } : {}), name: current.name, purpose: current.rest.join('\n').trim(),
      ...(meta.has('tags') ? { tags: split(meta.get('tags')!, /;/) } : {}), ...(meta.get('kind') ? { kind: meta.get('kind')!.trim() } : {}), fixed,
    });
    current = undefined;
  };
  for (const line of body.split('\n')) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading && !line.startsWith('###')) { close(); current = { name: oneLine(heading[1]), meta: new Map(), rest: [], inMeta: true }; continue; }
    if (!current) continue; // text before the first entry (a person's note) is not an entry
    const field = current.inMeta ? LINE.exec(line.trim()) : null;
    if (field) { current.meta.set(field[1].toLowerCase(), field[2].trim()); continue; }
    // A blank line after the info lines ends them: a description starting like "- access: …" stays description.
    if (current.inMeta && !line.trim()) { if (current.meta.size) current.inMeta = false; continue; }
    current.inMeta = false;
    current.rest.push(line.replace(/^ (#{1,6}\s)/, '$1'));
  }
  close();
  return { ...(route ? { route } : {}), entries };
}

/**
 * Does the section change what only the app sets? A line it states differently from the entry – and from `base`, the
 * app's last write of it, so a change the app made meanwhile is no edit of the person's.
 */
export function touchesFixed(parsed: ParsedEntry, entry: SecretEntry, base?: FixedValues): boolean {
  const now = fixedValues(entry);
  return FIXED_KEYS.some((key) => parsed.fixed[key] !== undefined && parsed.fixed[key] !== now[key] && (base === undefined || parsed.fixed[key] !== base[key]));
}

/** A legacy per-entry file (<id>.md before 29.10.2026): its id, name, purpose and kind, or undefined when it is none. */
export function parseLegacyFile(fileKey: string, text: string): { id: string; name?: string; purpose: string; kind?: string } | undefined {
  const { data, body } = parseFrontMatter(text);
  if (!('id' in data) && !('kind' in data && 'access' in data)) return undefined;
  if ('route' in data) return undefined;
  const name = typeof data.name === 'string' || typeof data.name === 'number' ? String(data.name).trim() : '';
  const kind = typeof data.kind === 'string' ? data.kind.trim() : undefined;
  const id = String(data.id ?? fileKey).trim() || fileKey;
  return { id: FILE_ID.test(id) ? id : fileKey, ...(name ? { name } : {}), purpose: body.trim(), ...(kind ? { kind } : {}) };
}
