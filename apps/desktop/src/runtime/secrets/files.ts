// The route files of the secrets catalog (owner 29.10.2026 – a catalog like a skill: a few routes, one file per route
// listing several entries; file-format.ts): <data>/secrets/<route>.md lists every single secret and group of that
// route – id, name, kind, tags, source, fields and the description, never a value, a hash or a hint; the value
// stays encrypted in the vault under the entry's id. The owner of the data folder entry 'secrets'
// (runtime/root/watcher.ts) with one TextDoc per route (runtime/root/text-doc.ts: atomic writes the watcher knows as
// the app's own, rejected copies, quiet notices):
//   - every metadata change of the vault (SecretVault.observe: save, describe, generate, capture, a removal) writes the
//     route files again (an entry that changed its route leaves its old file); a file edited on disk and not taken over
//     yet is reconciled first, so such an edit is never overwritten;
//   - an edit on disk (an editor, a script, an AI) of an entry's name (its ## heading), description or tags reaches the
//     vault as the person's edit (redacted there); an edit of what only the app sets – kind, source, fields –
//     is ignored with a quiet notice ('read-only') and the person's text kept as <route>.rejected.md; an entry without
//     a name is refused the same way ('invalid'); a too large, non-UTF-8 or unreadable file is moved aside as the
//     rejected copy and written again; an entry the file leaves out is written back (deleting is done in Settings);
//     a section of a known entry found in ANOTHER route's file moves the entry to that route (the route is the
//     catalog's area, not a permission) – its old file drops it on the next write;
//   - a section whose id the vault does not know is a "value missing" entry (missing(): written by hand or by an AI –
//     storing its value in Settings, prefilled from the file, makes it the vault's entry); it stays in its file; a
//     named section without a usable id gets one (entry-id.ts newEntryId, from its name) instead of being dropped;
//   - start (reconcileAll) writes every route file, takes over what was edited while the app was closed and moves the
//     legacy per-entry files <id>.md (before 29.10.2026) into their route files: an edited name or purpose is taken
//     over, an entry without a vault entry becomes a "value missing" section, then the legacy file goes.
// Every change is told as 'secrets.changed'. All work runs one after another.
// Owns: these rules and the folder. Never: writes a value, decides who may use a secret (the database does),
// treats file text as a permission, or polls.

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Bus } from '../bus.ts';
import type { Clock, Logger, SecretService } from '../contracts.ts';
import { autoSecretRoute, type SecretFileEntry, type SecretFileNotice, type SecretFileProblem, type SecretInfo } from '../../shared/model/security.ts';
import { ROOT_SECRETS } from '../root/layout.ts';
import { TextDoc, canonical, readText } from '../root/text-doc.ts';
import type { RootWatcher } from '../root/watcher.ts';
import {
  FILE_LIMITS, fileName, fixedValues, groupEntry, idOfFile, parseLegacyFile, parseRouteFile, renderRouteFile, routeOfFile, singleEntry, touchesFixed,
  type FixedValues, type ParsedEntry, type SecretEntry,
} from './file-format.ts';
import { newEntryId } from './entry-id.ts';

/** An id a handle can carry (secret://<id>). */
const USABLE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const FILE_NOTICES: Record<SecretFileProblem, string> = {
  'read-only': 'Its file changed what only the app sets (kind, source or fields); that change was ignored.',
  invalid: 'Its file has an entry without a usable name; the app kept its own and saved the edit as a rejected copy.',
  'too-large': 'Its file was too large to read; the app wrote it again and kept the old one as a rejected copy.',
  'not-text': 'Its file was not plain text; the app wrote it again and kept the old one as a rejected copy.',
  unreadable: 'Its file could not be read; the app wrote it again.',
};
const MAX_FILES = 1000;

export type ReconcileOutcome = 'written' | 'same' | 'taken' | 'problem' | 'missing' | 'skipped';

export interface SecretFilesDeps {
  dataDir: string;
  vault: Pick<SecretService, 'list' | 'groups' | 'save' | 'saveGroup' | 'redact'> & { observe?: SecretService['observe'] };
  clock: Clock;
  log: Logger;
  bus?: Pick<Bus, 'emit'>;
  /** The data folder watcher (absent: no live pick-up of edits on disk, e.g. tests). */
  root?: Pick<RootWatcher, 'register' | 'wrote' | 'flush'>;
}

/** A "value missing" entry as its file states it. */
type Unvalued = SecretEntry & { missing: true };

export class SecretFiles {
  private readonly deps: SecretFilesDeps;
  private readonly docs = new Map<string, TextDoc<SecretFileProblem>>();
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  /** The fixed lines (fixedValues) of each entry as the app last wrote it: what a person's edit is judged against. */
  private readonly written = new Map<string, FixedValues>();
  /** "Value missing" entries per route, as their file states them. */
  private readonly unvalued = new Map<string, Unvalued[]>();
  /** Ids the vault removed since the last reconcile: their sections leave the files (never "value missing"). */
  private readonly gone = new Set<string>();
  /** Ids changed since the queued pass was planned, and whether one is queued and not yet started (changed()). */
  private readonly waiting = new Set<string>();
  private passQueued = false;
  private off: Array<() => void> = [];

  constructor(deps: SecretFilesDeps) {
    this.deps = deps;
  }

  get folder(): string {
    return path.join(this.deps.dataDir, ROOT_SECRETS);
  }

  /** Start-up: the folder, the watcher and the vault hook, then legacy files moved and every route reconciled. */
  async start(): Promise<Record<ReconcileOutcome, number>> {
    mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    if (!this.off.length) {
      if (this.deps.root) this.off.push(this.deps.root.register(ROOT_SECRETS, (event) => this.onDisk(event.parts)));
      const unobserve = this.deps.vault.observe?.((id) => { this.changed(id); });
      if (unobserve) this.off.push(unobserve);
    }
    const counts = await this.reconcileAll();
    this.deps.log.info('secret files reconciled', counts);
    return counts;
  }

  stop(): void {
    for (const off of this.off.splice(0)) off();
  }

  /** Waits for the queued work (tests; the watcher's pending events first). */
  async flush(): Promise<void> {
    this.deps.root?.flush(ROOT_SECRETS);
    while (this.pending) await this.queue.catch(() => undefined);
  }

  /** Every route: legacy files moved in first, then each route file reconciled (counted per route). */
  reconcileAll(): Promise<Record<ReconcileOutcome, number>> {
    return this.run(async () => {
      const counts: Record<ReconcileOutcome, number> = { written: 0, same: 0, taken: 0, problem: 0, missing: 0, skipped: 0 };
      const moved = await this.moveLegacy();
      for (const route of this.routes()) counts[await this.reconcile(route)]++;
      counts.taken += moved;
      return counts;
    });
  }

  /** The entries without a vault entry ("value missing"), as their files say. */
  missing(): SecretFileEntry[] {
    const known = this.knownIds();
    const out: SecretFileEntry[] = [];
    for (const route of this.fileRoutes()) {
      const read = readText(path.join(this.folder, fileName(route)), FILE_LIMITS);
      if (read.kind !== 'ok') continue;
      for (const entry of parseRouteFile(read.text).entries) {
        if (!entry.id || known.has(entry.id) || !entry.name) continue;
        out.push({ id: entry.id, name: entry.name, ...(entry.purpose ? { purpose: entry.purpose } : {}), kind: (entry.kind ?? 'api_key') as SecretFileEntry['kind'], route, ...(entry.tags?.length ? { tags: entry.tags } : {}) });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  notices(): SecretFileNotice[] {
    const out: SecretFileNotice[] = [];
    for (const [route, doc] of this.docs) if (doc.notice) out.push({ id: route, problem: doc.notice.problem, text: FILE_NOTICES[doc.notice.problem], at: doc.notice.at });
    return out;
  }

  /** The vault changed an entry's metadata (or removed it – `id` then leaves its file): the route files follow. */
  changed(id?: string): void {
    if (id && !this.knownIds().has(id)) this.gone.add(id);
    if (id) this.waiting.add(id);
    // Changes that arrive while one pass is still queued join it (a password import stores hundreds at once).
    if (this.passQueued) return;
    this.passQueued = true;
    void this.run(async () => {
      this.passQueued = false;
      const ids = [...this.waiting];
      this.waiting.clear();
      for (const route of this.routes()) await this.reconcile(route);
      for (const done of ids) this.gone.delete(done);
      this.emit();
    });
  }

  /** One route file into the vault and back (see the header). */
  private async reconcile(route: string): Promise<ReconcileOutcome> {
    const doc = this.doc(route);
    const read = doc.safeCheck();
    let entries = this.entriesOf(route);
    if (read.kind === 'missing') {
      if (!entries.length) { this.unvalued.delete(route); return 'skipped'; }
      this.write(route, entries, []);
      return 'written';
    }
    if (read.kind === 'problem') {
      doc.keepRejected('move');
      this.write(route, entries, this.unvalued.get(route) ?? []);
      doc.setNotice(read.problem);
      return 'problem';
    }
    const parsed = parseRouteFile(read.text).entries;
    const known = this.knownIds();
    this.giveIds(parsed, known);
    const unvalued = parsed.filter((entry): entry is ParsedEntry & { id: string } => Boolean(entry.id) && !known.has(entry.id!) && !this.gone.has(entry.id!) && Boolean(entry.name))
      .map((entry) => this.asUnvalued(route, entry));
    this.unvalued.set(route, unvalued);
    const next = renderRouteFile(route, [...entries, ...unvalued]);
    if (read.text === canonical(next)) {
      doc.adopt(read.sig);
      for (const entry of entries) this.written.set(entry.id, fixedValues(entry));
      return unvalued.length ? 'missing' : 'same';
    }
    if (!doc.isOutside(read)) { this.write(route, entries, unvalued); return 'written'; }
    // An edit on disk: name, description and tags are taken over; what only the app sets is judged per entry.
    let problem: SecretFileProblem | undefined;
    let taken = false;
    for (const file of parsed) {
      const entry = file.id ? entries.find((item) => item.id === file.id) : undefined;
      if (!entry) {
        // A known entry's section in this route's file: moved here (review: the route can change in the file).
        const elsewhere = file.id && file.name ? this.entry(file.id) : undefined;
        if (!elsewhere || elsewhere.route === route) continue;
        try {
          await this.takeOver(elsewhere, file.name, file.purpose, file.tags, route);
          taken = true;
        } catch (error) {
          this.deps.log.warn('secret file entry not moved', { id: elsewhere.id, error: String(error) });
          problem ??= 'invalid';
        }
        continue;
      }
      if (!file.name) { problem ??= 'invalid'; continue; }
      if (touchesFixed(file, entry, this.written.get(entry.id))) problem = 'read-only';
      const rename = file.name !== entry.name;
      const repurpose = file.purpose !== entry.purpose.trim();
      const retag = file.tags !== undefined && JSON.stringify(file.tags) !== JSON.stringify(entry.tags);
      if (!rename && !repurpose && !retag) continue;
      try {
        await this.takeOver(entry, file.name, file.purpose, retag ? file.tags : undefined);
        taken = true;
      } catch (error) {
        this.deps.log.warn('secret file entry not taken over', { id: entry.id, error: String(error) });
        problem ??= 'invalid';
      }
    }
    if (problem) {
      try { doc.writeRejected(this.deps.vault.redact(read.text)); } catch (error) { this.deps.log.debug('rejected secret file not kept', { route, error: String(error) }); }
    }
    entries = this.entriesOf(route);
    this.write(route, entries, unvalued); // canonical text with the vault's values
    doc.setNotice(problem);
    this.emit();
    return problem ? 'problem' : taken ? 'taken' : 'same';
  }

  /** The name, description and tags (and a new `route`) from the file, as the person's edit (the vault redacts and checks them). */
  private async takeOver(entry: SecretEntry, name: string, purpose: string, tags: string[] | undefined, route?: string): Promise<void> {
    const moved = route ? { route } : {};
    if (entry.group) { await this.deps.vault.saveGroup({ id: entry.id, label: name, description: purpose, ...(tags ? { tags } : {}), ...moved }); return; }
    const info = this.deps.vault.list().find((row) => row.id === entry.id);
    if (!info) return;
    await this.deps.vault.save({ id: info.id, label: name, kind: info.kind, description: purpose, ...(tags ? { tags } : {}), ...moved });
  }

  /** A named section without a usable id gets a new one (from its name), unique against the vault and every file. */
  private giveIds(parsed: ParsedEntry[], known: ReadonlySet<string>): void {
    if (!parsed.some((entry) => entry.name && (!entry.id || !USABLE_ID.test(entry.id)))) return;
    const taken = [...known, ...[...this.unvalued.values()].flat().map((entry) => entry.id), ...parsed.map((entry) => entry.id ?? '')]
      .filter(Boolean).map((id) => ({ id }));
    for (const entry of parsed) {
      if (!entry.name || (entry.id && USABLE_ID.test(entry.id))) continue;
      entry.id = newEntryId(taken, [], entry.name);
      taken.push({ id: entry.id });
    }
  }

  /**
   * The legacy files <id>.md (one per entry, before 29.10.2026) into the route files: an edited name or purpose of a
   * vault entry is taken over, a file without a vault entry becomes a "value missing" section of its route; then the
   * legacy file is removed. Returns how many were moved.
   */
  private async moveLegacy(): Promise<number> {
    let moved = 0;
    for (const key of this.fileKeys()) {
      if (routeOfFile(fileName(key)) !== undefined && this.isRouteFile(key)) continue;
      const file = path.join(this.folder, fileName(key));
      const read = readText(file, FILE_LIMITS);
      if (read.kind !== 'ok') continue;
      const legacy = parseLegacyFile(key, read.text);
      if (!legacy) continue;
      const entry = this.entry(legacy.id);
      try {
        if (entry) {
          const name = legacy.name ?? entry.name;
          if (name !== entry.name || legacy.purpose !== entry.purpose.trim()) await this.takeOver(entry, name, legacy.purpose, undefined);
        } else if (legacy.name) {
          const route = autoSecretRoute(legacy.kind ?? 'api_key', `${legacy.name} ${legacy.purpose}`, legacy.kind);
          const list = this.unvalued.get(route) ?? this.readUnvalued(route);
          if (!list.some((item) => item.id === legacy.id)) list.push({ id: legacy.id, name: legacy.name, purpose: legacy.purpose, kind: legacy.kind ?? 'api_key', route, tags: [], fields: [], group: false, missing: true });
          this.unvalued.set(route, list);
          this.write(route, this.entriesOf(route), list);
        }
      } catch (error) {
        this.deps.log.warn('legacy secret file not taken over', { id: legacy.id, error: String(error) });
      }
      this.removeFile(file);
      moved++;
    }
    return moved;
  }

  /** Is <key>.md a route file (its front matter names a route, or it is the app's own route file)? */
  private isRouteFile(key: string): boolean {
    const read = readText(path.join(this.folder, fileName(key)), FILE_LIMITS);
    return read.kind !== 'ok' || parseLegacyFile(key, read.text) === undefined;
  }

  private readUnvalued(route: string): Unvalued[] {
    const read = readText(path.join(this.folder, fileName(route)), FILE_LIMITS);
    if (read.kind !== 'ok') return [];
    const known = this.knownIds();
    const parsed = parseRouteFile(read.text).entries;
    this.giveIds(parsed, known);
    return parsed.filter((entry) => entry.id && !known.has(entry.id) && entry.name).map((entry) => this.asUnvalued(route, entry as ParsedEntry & { id: string }));
  }

  private asUnvalued(route: string, entry: ParsedEntry & { id: string }): Unvalued {
    return { id: entry.id, name: entry.name, purpose: entry.purpose, kind: entry.kind ?? 'api_key', route, tags: entry.tags ?? [], fields: [], group: false, missing: true };
  }

  /** Runs `work` after everything queued before it (one after another – route files share entries). */
  private run<T>(work: () => Promise<T>): Promise<T> {
    this.pending++;
    const next = this.queue.then(work, work);
    this.queue = next.catch((error: unknown) => { this.deps.log.warn('secret files not reconciled', { error: String(error) }); });
    void this.queue.finally(() => { this.pending--; });
    return next;
  }

  /** A watcher event below <data>/secrets: one route file, or (a legacy file, unknown or the folder itself) everything. */
  private onDisk(parts: readonly string[] | undefined): void {
    const route = parts?.length === 1 ? routeOfFile(parts[0]) : undefined;
    if (route && this.isRouteFile(route)) { void this.run(async () => { await this.reconcile(route); this.emit(); }); return; }
    void this.reconcileAll().then(() => this.emit());
  }

  private write(route: string, entries: readonly SecretEntry[], unvalued: readonly SecretEntry[]): void {
    const file = path.join(this.folder, fileName(route));
    try {
      if (!entries.length && !unvalued.length) {
        if (existsSync(file)) { rmSync(file, { force: true }); this.deps.root?.wrote(file, null); }
        this.docs.get(route)?.forget();
        this.docs.delete(route);
        return;
      }
      this.doc(route).write(renderRouteFile(route, [...entries, ...unvalued]));
      for (const entry of entries) this.written.set(entry.id, fixedValues(entry));
    } catch (error) {
      this.deps.log.warn('secret file not written', { route, error: String(error) });
    }
  }

  private removeFile(file: string): void {
    try { rmSync(file, { force: true }); } catch (error) { this.deps.log.warn('legacy secret file not removed', { error: String(error) }); return; }
    this.deps.root?.wrote(file, null);
  }

  private emit(): void {
    try { this.deps.bus?.emit('secrets.changed', {}); } catch { /* listeners only */ }
  }

  private doc(route: string): TextDoc<SecretFileProblem> {
    let doc = this.docs.get(route);
    if (!doc) {
      doc = new TextDoc<SecretFileProblem>({
        file: path.join(this.folder, fileName(route)), limits: FILE_LIMITS, clock: this.deps.clock, writes: this.deps.root,
        onNotice: (notice) => { if (notice) this.deps.log.warn('secret file notice', { route, problem: notice.problem }); },
      });
      this.docs.set(route, doc);
    }
    return doc;
  }

  /** Every single secret (not a field of a group) and every group, as file entries. */
  private entries(): SecretEntry[] {
    const all = this.deps.vault.list();
    return [
      ...all.filter((info) => !info.group).map(singleEntry),
      ...this.deps.vault.groups().map((group) => groupEntry(group, fieldsOf(all, group.id))),
    ];
  }

  private entriesOf(route: string): SecretEntry[] {
    return this.entries().filter((entry) => entry.route === route);
  }

  private entry(id: string): SecretEntry | undefined {
    return this.entries().find((entry) => entry.id === id);
  }

  /** Every id the vault knows (single secrets, fields and groups). */
  private knownIds(): Set<string> {
    return new Set([...this.deps.vault.list().map((info) => info.id), ...this.deps.vault.groups().map((group) => group.id)]);
  }

  /** The routes to reconcile: the vault's, the route files' and the ones with "value missing" entries. */
  private routes(): string[] {
    return [...new Set([...this.entries().map((entry) => entry.route), ...this.fileRoutes(), ...this.unvalued.keys()])].sort();
  }

  /** The route files in the folder (legacy entry files left out). */
  private fileRoutes(): string[] {
    return this.fileKeys().filter((key) => routeOfFile(fileName(key)) !== undefined && this.isRouteFile(key));
  }

  /** The keys of the .md files in the folder (rejected copies and other files left out), at most MAX_FILES. */
  private fileKeys(): string[] {
    try {
      return readdirSync(this.folder, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => idOfFile(entry.name))
        .filter((key): key is string => key !== undefined).sort().slice(0, MAX_FILES);
    } catch { return []; }
  }
}

const ORDER = ['username', 'password', 'totp', 'number', 'expiry', 'cvc', 'holder'];
/** A group's fields in a stable order (the template's first, then by creation). */
function fieldsOf(all: readonly SecretInfo[], groupId: string): SecretInfo[] {
  const rank = (info: SecretInfo) => { const at = ORDER.indexOf(info.field ?? ''); return at < 0 ? ORDER.length : at; };
  return all.filter((info) => info.group?.id === groupId).sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
