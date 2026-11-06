// What a read of <data>/settings.json applies: the file holds every setting (schema.ts writes it whole); a key it
// lacks or sets to null means its default. Each section is checked on its own against the last good settings, so
// one invalid section never costs the others. An older file that held only the values differing from the defaults
// reads the same way – the next write makes it whole. Also the one-time move of the old database rows into the file.
// Owns: these rules and the notice text. Never: reads or writes files, emits events (service.ts).

import { isDeepStrictEqual } from 'node:util';
import type { Settings } from '../../shared/model/system.ts';
import { SECTIONS, defaultOf, type KeyDef, type PcDefaults } from './schema.ts';
import { RETIRED_SECTIONS, checkPatchShape, deepMerge, isSettingsSection, unknownKeys, validateSettings } from './validate.ts';
import { migrateModelSettings } from '../routing/uses-settings.ts';

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain => typeof value === 'object' && value !== null && !Array.isArray(value);
const sectionOf = (settings: Settings, section: string): unknown => (settings as unknown as Plain)[section];

/** `value` without its null members, at any depth of plain objects (null in the file = the default). */
export function withoutNulls(value: unknown): unknown {
  if (!isPlain(value)) return value;
  const out: Plain = {};
  for (const [key, item] of Object.entries(value)) if (item !== null && item !== undefined) out[key] = withoutNulls(item);
  return out;
}

/** An optional section's value without what equals its defaults (undefined: nothing is set). */
function setPart(value: unknown, defs: readonly KeyDef[], pc: PcDefaults): unknown {
  if (!isPlain(value)) return value;
  const out: Plain = {};
  for (const [key, item] of Object.entries(value)) {
    const def = defs.find((entry) => entry.key === key);
    const rest = def?.keys ? setPart(item, def.keys, pc) : item;
    if (rest === undefined || (def && !def.keys && isDeepStrictEqual(rest, defaultOf(def, pc)))) continue;
    out[key] = rest;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * The settings in their one form in memory: an optional section (lifecycle, calendar) holds only what differs from
 * its defaults and is absent when nothing does – the same settings read the same after a write and a read.
 */
export function settled(settings: Settings, pc: PcDefaults): Settings {
  const out = settings as unknown as Plain;
  for (const section of SECTIONS) {
    if (!section.optional || out[section.key] === undefined) continue;
    const rest = setPart(out[section.key], section.keys, pc);
    if (rest === undefined) delete out[section.key];
    else out[section.key] = rest;
  }
  return settings;
}

/** This PC's language and time zone as the defaults hold them. */
export const pcOf = (defaults: Settings): PcDefaults => ({ language: defaults.profile.language, timezone: defaults.profile.timezone });

/** One section of the file that is not applied (its last good value stays), with a short reason. */
export interface FileProblem {
  section: string;
  detail: string;
}

/** Why `value` cannot be the section `section` (undefined: it can). */
export function sectionProblem(section: string, value: unknown, base: Settings, defaults: Settings): string | undefined {
  if (!isSettingsSection(section)) return `${section} is not a settings section`;
  if (!isPlain(value)) return `${section} must be an object`;
  try {
    checkPatchShape({ [section]: value });
    validateSettings({ ...structuredClone(base), [section]: deepMerge(sectionOf(defaults, section) ?? {}, value) } as Settings);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message.replace(/^Invalid setting /, '').replace(/\.$/, '') : `${section} is invalid`;
  }
}

export interface ReadSettings {
  settings: Settings;
  problems: FileProblem[];
  /** The sections that were not applied, as written (they stay in the file until fixed). */
  rejected: Plain;
  /** Keys no section knows ('voice.foo'): left out – the file is written again without them. */
  dropped: string[];
}

/**
 * The settings `data` (file sections) says: the defaults, each usable section merged over its defaults (null and a
 * missing key: the default), and for a section that is not usable its value in `base` (the last good settings). An
 * unknown key of a known section is left out (`dropped`) and the rest of the section applies – a key a newer app
 * version no longer has never costs the whole section. "$schema" (the file's pointer to its JSON Schema) is no section.
 */
export function settingsFrom(file: Plain, base: Settings, defaults: Settings): ReadSettings {
  const data = migrateModelSettings(file); // older model keys become the uses (routing/uses-settings.ts)
  const problems: FileProblem[] = [];
  const rejected: Plain = {};
  const dropped: string[] = [];
  const out = structuredClone(defaults) as unknown as Plain;
  for (const [section, written] of Object.entries(data)) {
    if (section === '$schema') continue;
    if (RETIRED_SECTIONS.has(section)) { dropped.push(section); continue; }
    let value = withoutNulls(written);
    if (isSettingsSection(section) && isPlain(value)) {
      const unknown = unknownKeys(section, value);
      if (unknown.length) {
        dropped.push(...unknown.map((key) => `${section}.${key}`));
        value = Object.fromEntries(Object.entries(value).filter(([key]) => !unknown.includes(key)));
      }
    }
    const problem = written === null && isSettingsSection(section) ? undefined : sectionProblem(section, value, base, defaults);
    if (problem) {
      problems.push({ section, detail: problem });
      rejected[section] = written;
      if (isSettingsSection(section) && sectionOf(base, section) !== undefined) out[section] = structuredClone(sectionOf(base, section));
    } else if (written !== null) {
      out[section] = deepMerge(sectionOf(defaults, section) ?? {}, value);
    }
  }
  const settings = settled(out as unknown as Settings, pcOf(defaults));
  try {
    validateSettings(settings); // each section passed alone; this also applies the read-time rewrites (validate.ts)
    return { settings, problems, rejected, dropped };
  } catch (error) {
    return { settings: structuredClone(base), problems: [...problems, { section: 'settings', detail: String((error as Error).message ?? error) }], rejected: {}, dropped: [] };
  }
}

/** The quiet notice: what was not applied and why (no paths, no file content). */
export function noticeText(problems: readonly FileProblem[], whole?: string): string {
  if (whole) return `${whole}. The last good values stay until the file is fixed.`;
  const sections = [...new Set(problems.map((problem) => problem.section))];
  const first = problems[0]?.detail ?? 'a value is invalid';
  return `settings.json: ${sections.join(', ')} ${sections.length === 1 ? 'was' : 'were'} not applied (${first}). The last good values stay until the file is fixed.`;
}

/** Sections of the old split store that were in settings.json; the others lived in the database only. */
const OLD_FILE_SECTIONS: ReadonlySet<string> = new Set(['profile', 'preferences', 'notifications', 'voice', 'routing', 'day', 'org', 'lifecycle']);
/** Keys of those sections that never reached the old file. */
const OLD_DATABASE_KEYS: Readonly<Record<string, readonly string[]>> = {
  preferences: ['closeToTray', 'openAtLogin', 'autoDownloadUpdates'],
  routing: ['allowPaidFallback'],
};

/**
 * The one-time move of the old `settings` table (one stored section per row) into the file's sections: without a
 * usable file the rows are everything; with one, the file's values win and the rows add what the old file never
 * held (the database-only sections and keys).
 */
export function withOldRows(file: Plain | undefined, rows: Plain): Plain {
  if (!file) return structuredClone(rows);
  const out: Plain = { ...file };
  for (const [section, row] of Object.entries(rows)) {
    if (!isPlain(row)) continue;
    if (!OLD_FILE_SECTIONS.has(section)) {
      if (!(section in out)) out[section] = structuredClone(row);
      continue;
    }
    const extra: Plain = {};
    for (const key of OLD_DATABASE_KEYS[section] ?? []) if (row[key] !== undefined) extra[key] = row[key];
    if (Object.keys(extra).length) out[section] = { ...extra, ...(isPlain(out[section]) ? out[section] : {}) };
  }
  return out;
}

/** True when two settings say the same. */
export const sameSettings = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a ?? {}, b ?? {});
