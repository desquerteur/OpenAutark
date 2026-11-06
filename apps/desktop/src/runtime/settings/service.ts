// SettingsStore: every setting of the app – <data>/settings.json, the one store. The app writes the file whole:
// every key with its current value and a comment line above it (what it does, the allowed values, the default –
// schema.ts), and settings.schema.json beside it. The person, an agent or a script edits the file with any editor;
// the data folder watcher hands the edit over (fromDisk) and it applies like an update (a missing key or null: the
// default). Each section is checked on its own: one that is not valid is not applied – its last good value stays,
// the file keeps it as written with the reason above it – and a quiet notice names it ('settings.notice'; held() lists
// such sections, so a writer of one key can leave a section alone that an update would replace); a key no
// section knows is left out. After every read and change the file is written again when its text differs from the
// whole, current one (comments never stale; an older file holding only the values that differ from the defaults
// becomes whole once, every value kept). update() merges, validates, writes the file atomically and emits
// 'settings.updated'; one stat before makes sure an edit not handed over yet comes first. A missing file is
// written again from the current values; a file that is no JSON object at all is copied to settings.rejected.json
// before the app writes over it (until then nothing is written).
// Once: the old database table's rows move into the file (the file's own values win) and the table is emptied.
// A settings.json that is still the pre-rebuild store (schema 1–7) is neither read nor written until
// db/import-v7.ts has moved it aside. Without a data folder (tests) the settings live in memory only.
// Owns: these rules and the 'settings.updated' / 'settings.notice' events. Never: secret values (only ids such as
// calendar.googleSecretId), a partial write of an invalid result, or polling.

import { closeSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import type { Bus } from '../bus.ts';
import type { Clock, Logger, SettingsService } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import { isLegacyStore, looksLegacy } from '../db/legacy-store.ts';
import type { Settings, SettingsPatch } from '../../shared/model/system.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { ROOT_SETTINGS } from '../root/layout.ts';
import { TextDoc, canonical, readText, writeAtomic, type TextProblem, type TextRead } from '../root/text-doc.ts';
import type { RootWatcher } from '../root/watcher.ts';
import { defaultSettings, type SystemEnvironment } from './defaults.ts';
import { SETTINGS_SCHEMA_FILE, parseText, schemaText, settingsText, type PcDefaults } from './schema.ts';
import { noticeText, pcOf, sameSettings, settingsFrom, settled, withOldRows, type FileProblem } from './read.ts';
import { checkPatchShape, deepMerge, validateSettings } from './validate.ts';

/** settings.json is never larger (1000 learned words fit many times). */
export const SETTINGS_FILE_MAX_BYTES = 1024 * 1024;

export interface SettingsDeps {
  bus: Bus;
  clock: Clock;
  /** Only for the one-time move of the old `settings` table (absent: nothing to move). */
  db?: Db;
  env?: SystemEnvironment; // OS locale/timezone (tests pass fixed values)
  /** <data>, home of settings.json (absent: memory only – tests, fakes). */
  dataDir?: string;
  /** The data folder watcher: own writes and the owner of settings.json. */
  root?: RootWatcher;
  log?: Logger;
}

type Plain = Record<string, unknown>;

const READ_PROBLEM: Record<TextProblem, string> = {
  'too-large': 'settings.json is too large to use',
  'not-text': 'settings.json is not a text file',
  unreadable: 'settings.json cannot be read',
};

/** What a read found, as one comparable key. */
const readKey = (read: TextRead): string => (read.kind === 'ok' ? `text:${read.text}` : read.kind === 'missing' ? 'missing' : `sig:${read.sig}`);

export class SettingsStore implements SettingsService {
  private readonly deps: SettingsDeps;
  private readonly defaults: Settings;
  /** This PC's language and time zone (the defaults' comments show them). */
  private readonly pc: PcDefaults;
  private readonly doc?: TextDoc;
  /** settings.schema.json is current (checked once per start). */
  private schemaDone = false;
  private cache: Settings | undefined;
  /** The old table's rows not moved yet (undefined: not read yet). */
  private rows: Plain | undefined;
  /** What the file held when the app last took it over or wrote it (readKey). */
  private seen: string | undefined;
  /** Sections of the file that are not applied, as written (kept in the file until fixed). */
  private rejected: Plain = {};
  /** What the notice says was not applied. */
  private problems: FileProblem[] = [];
  /** The file is no usable JSON object (copied aside before the app writes over it). */
  private unusable = false;
  /** The file is the pre-rebuild store (see the header). */
  private legacy = false;
  private noticeText: string | undefined;
  private offWatch?: () => void;

  constructor(deps: SettingsDeps) {
    this.deps = deps;
    this.defaults = defaultSettings(deps.env);
    this.pc = pcOf(this.defaults);
    if (deps.dataDir) {
      this.doc = new TextDoc({ file: path.join(deps.dataDir, ROOT_SETTINGS), limits: { maxBytes: SETTINGS_FILE_MAX_BYTES }, clock: deps.clock, writes: deps.root });
      this.offWatch = deps.root?.register(ROOT_SETTINGS, () => this.fromDisk());
    }
  }

  get(): Settings {
    this.cache ??= this.load();
    return structuredClone(this.cache);
  }

  /** The quiet notice of settings.json (a part not applied), when there is one. */
  notice(): string | undefined {
    return this.noticeText;
  }

  /** The sections of settings.json not applied right now, kept there as written; an update of one replaces it. */
  held(): string[] {
    if (this.cache) this.fromDisk(); // an edit not handed over yet counts
    this.cache ??= this.load();
    return Object.keys(this.rejected);
  }

  /** Stops hearing about edits of settings.json (the runtime's stop). */
  close(): void {
    this.offWatch?.();
    this.offWatch = undefined;
  }

  update(patch: SettingsPatch): Settings {
    checkPatchShape(patch);
    if (this.doc) {
      this.deps.root?.ensure();
      if (this.cache && this.changedOnDisk()) this.cache = this.load(); // an edit on disk not handed over yet comes first
    }
    const next = deepMerge(this.get(), patch);
    validateSettings(next);
    settled(next, this.pc);
    for (const section of Object.keys(patch)) delete this.rejected[section]; // the change replaces what was not applied
    if (this.doc) this.write(next, true);
    this.cache = next;
    this.problems = this.problems.filter((problem) => !(problem.section in patch) && problem.section in this.rejected);
    this.setNotice(undefined);
    const result = this.get();
    this.deps.bus.emit('settings.updated', result);
    return result;
  }

  /** The watcher saw settings.json change: the edit is taken over and announced (nothing when it says the same). */
  fromDisk(): void {
    if (!this.doc || !this.changedOnDisk(true)) return;
    const before = this.cache;
    this.cache = this.load();
    if (before && sameSettings(before, this.cache)) return;
    this.deps.bus.emit('settings.updated', this.get());
  }

  // ---------------------------------------------------------------- internals

  private changedOnDisk(fresh = false): boolean {
    if (fresh) this.doc!.forget();
    return readKey(this.doc!.safeCheck()) !== this.seen;
  }

  private load(): Settings {
    const base = this.cache ?? this.defaults;
    const rows = this.oldRows();
    if (!this.doc) return settingsFrom(rows, base, this.defaults).settings;
    const read = this.doc.safeCheck();
    this.seen = readKey(read);
    this.legacy = this.isLegacy(read);
    if (this.legacy) return this.cache ?? settingsFrom(rows, base, this.defaults).settings;
    if (read.kind === 'missing') {
      const settings = this.cache ?? settingsFrom(rows, base, this.defaults).settings;
      this.rejected = {};
      this.problems = [];
      this.unusable = false;
      this.setNotice(undefined);
      this.write(settings, false);
      return settings;
    }
    const parsed = read.kind === 'ok' ? parseText(read.text) : { whole: READ_PROBLEM[read.problem] };
    const moving = Object.keys(rows).length > 0;
    if (!parsed.data && !moving) { // nothing of it can be used: the last good values stay
      this.unusable = true;
      this.rejected = {};
      this.problems = [];
      this.setNotice(parsed.whole);
      return structuredClone(base);
    }
    const data = moving ? withOldRows(parsed.data, rows) : parsed.data ?? {};
    const { settings, problems, rejected, dropped } = settingsFrom(data, base, this.defaults);
    this.unusable = parsed.data === undefined;
    this.rejected = rejected;
    this.problems = problems;
    this.setNotice(parsed.whole);
    if (dropped.length) this.deps.log?.info('unknown settings left out of settings.json', { keys: dropped });
    // Whole and current: written only when the text differs – never over a file whose sections only fail together.
    if (!problems.some((problem) => problem.section === 'settings')) this.write(settings, false);
    return settings;
  }

  /** Writes `settings` (sections not applied stay as written); `strict` throws when it fails, else it is logged. */
  private write(settings: Settings, strict: boolean): void {
    const doc = this.doc!;
    if (this.legacy) return; // the pre-rebuild store stays until its import moved it; the values are in memory
    this.writeSchema();
    const why = Object.fromEntries([...this.problems].reverse().map((problem) => [problem.section, problem.detail]));
    const text = settingsText(settings, this.pc, this.rejected, why);
    const read = doc.safeCheck();
    if (read.kind === 'ok' && read.text === canonical(text)) { this.seen = readKey(read); this.dropOldRows(); return; } // it already says this
    try {
      if (this.unusable && read.kind !== 'missing') doc.keepRejected('copy');
      doc.write(text);
    } catch (error) {
      this.deps.log?.warn('settings.json not written', { error: String(error) });
      if (strict) throw new WorkforceError('unavailable', 'The settings could not be saved: settings.json in the Autark folder cannot be written.');
      return;
    }
    this.seen = `text:${canonical(text)}`;
    this.unusable = false;
    this.dropOldRows();
  }

  /** settings.schema.json beside the file, written when missing or out of date (once per start; a failure is logged). */
  private writeSchema(): void {
    if (this.schemaDone) return;
    this.schemaDone = true;
    const file = path.join(path.dirname(this.doc!.file), SETTINGS_SCHEMA_FILE);
    const text = schemaText(this.pc);
    try {
      const read = readText(file, { maxBytes: SETTINGS_FILE_MAX_BYTES });
      if (read.kind === 'ok' && read.text === canonical(text)) return;
      writeAtomic(file, text, this.deps.root);
    } catch (error) {
      this.deps.log?.warn('settings.schema.json not written', { error: String(error) });
    }
  }

  /** The old `settings` table's rows (read once; {} when there are none or the table is gone). */
  private oldRows(): Plain {
    if (this.rows) return this.rows;
    const rows: Plain = {};
    try {
      for (const row of this.deps.db?.all<{ key: string; value: string }>('SELECT key, value FROM settings') ?? []) {
        try { rows[row.key] = JSON.parse(row.value); } catch { /* a broken row is skipped */ }
      }
    } catch { /* no such table */ }
    this.rows = rows;
    return rows;
  }

  /** The rows are in the file now: the table is emptied, so they never come back. */
  private dropOldRows(): void {
    if (!this.rows || !Object.keys(this.rows).length) return;
    try { this.deps.db?.run('DELETE FROM settings'); } catch (error) { this.deps.log?.warn('old settings rows not removed', { error: String(error) }); return; }
    this.deps.log?.info('settings moved into settings.json', { sections: Object.keys(this.rows) });
    this.rows = {};
  }

  /** True when `read` is the pre-rebuild store (schema 1–7) that db/import-v7.ts has not moved aside yet. */
  private isLegacy(read: TextRead): boolean {
    if (read.kind === 'ok') {
      if (!read.text.includes('"schema"')) return false;
      try { return isLegacyStore(JSON.parse(read.text)); } catch { return false; }
    }
    return read.kind === 'problem' && read.problem === 'too-large' && looksLegacy(head(this.doc!.file));
  }

  /** The notice for the problems now (and `whole`: the file cannot be used at all); told only when it changes. */
  private setNotice(whole: string | undefined): void {
    const text = whole || this.problems.length ? noticeText(this.problems, whole) : undefined;
    if (text === this.noticeText) return;
    this.noticeText = text;
    if (text) this.deps.log?.warn('settings.json not fully applied', { detail: text });
    this.deps.bus.emit('settings.notice', text ? { text } : {});
  }
}

/** The file's first characters (a file too large to read whole); '' when it cannot be read. */
function head(file: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const bytes = Buffer.alloc(256);
    return bytes.toString('utf8', 0, readSync(fd, bytes, 0, bytes.length, 0));
  } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
}
