// Default values for the full Settings shape, built from the definitions in schema.ts (each default is written
// down there once, next to what the key does). Language and time zone come from the OS.
// Owns: what a fresh installation starts with and this PC's locale. Never: persistence or validation.
// Defaults follow the confirmed decisions: pushes only for human to-dos, blockers and important messages, with a
// sound (B-072); My day (B-041): working hours 08:00–20:00, 10 min buffer, the morning plan at 06:00, AI helps on, keep
// awake on, agents' lane off; B-044: Realtime call voice off; B-055: a new install starts with the feedback tour.

import type { Settings } from '../../shared/model/system.ts';
import { SECTIONS, defaultOf, type KeyDef, type PcDefaults } from './schema.ts';

export interface SystemEnvironment {
  locale?: string; // e.g. 'de-DE'; default Intl
  timezone?: string; // IANA; default Intl
}

/** OS locale/timezone as seen by Intl (Node and Electron both mirror the OS). */
export function systemEnvironment(): Required<SystemEnvironment> {
  const options = Intl.DateTimeFormat().resolvedOptions();
  return { locale: options.locale || 'en', timezone: options.timeZone || 'UTC' };
}

/** 'de-DE' → 'de'; anything unusable → 'en'. */
export function languageOf(locale: string): string {
  const match = /^([a-z]{2,3})(?:[-_]|$)/i.exec(locale.trim());
  return match ? match[1].toLowerCase() : 'en';
}

/** The defaults of every section that has them (schema.ts – the one place each default is written down). */
export function defaultSettings(env: SystemEnvironment = {}): Settings {
  const system = systemEnvironment();
  const pc: PcDefaults = { language: languageOf(env.locale ?? system.locale), timezone: env.timezone ?? system.timezone };
  const out: Record<string, unknown> = {};
  for (const section of SECTIONS) if (!section.optional) out[section.key] = defaultsOf(section.keys, pc);
  return out as unknown as Settings;
}

/** The keys of `defs` that have a default (nested objects included). */
function defaultsOf(defs: readonly KeyDef[], pc: PcDefaults): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of defs) {
    const value = def.keys ? defaultsOf(def.keys, pc) : defaultOf(def, pc);
    if (value !== undefined) out[def.key] = value;
  }
  return out;
}
