// Validation and merge rules for Settings.
// Owns: the value checks and the deep-merge semantics of patches. The known keys, the options, ranges and patterns
// come from the definitions (schema.ts), so settings.json's comments and these checks never disagree.
// Never: persistence or events (service.ts).
//
// Merge semantics: plain objects merge recursively; arrays and primitives replace; `null`
// removes an optional key (JSON has no undefined, so null is how clients clear a field).

import { WorkforceError } from '../../shared/errors.ts';
import type { Settings } from '../../shared/model/system.ts';
import { relayAddress } from '../../shared/model/relay.ts';
import { localSpeechIds, localSpeechModel } from '../../shared/model/local-speech-models.ts';
import { entryConnection, entryProblem } from '../../shared/model/provider-entries.ts';
import { endpointFor } from '../engines/http/common.ts';
import { validateRouting } from '../routing/uses-settings.ts';
import { validateLifecycle } from '../knowledge/lifecycle-settings.ts';
import { clockMinutes } from '../../shared/model/day-settings.ts';
import { MAX_WORDS } from '../../shared/voice/vocabulary.ts';
import { MAX_HINTS, NOTES_MAX, PATTERNS, SECTIONS, optionsOf, rangeOf } from './schema.ts';

type Plain = Record<string, unknown>;

const isPlain = (value: unknown): value is Plain =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Keys allowed per section, from the definitions. */
const KEYS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(SECTIONS.map((section) => [section.key, section.keys.map((def) => def.key)]));
/** Sections whose keys are free (validateSettings checks their entries). */
const FREE: ReadonlySet<string> = new Set(SECTIONS.filter((section) => section.free).map((section) => section.key));

function bad(path: string, expected: string): never {
  throw new WorkforceError('bad_request', `Invalid setting ${path}: expected ${expected}.`, { details: { path } });
}

/** Deep merge (see header). Returns a new object; inputs are not mutated. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlain(patch) || !isPlain(base)) return (patch === undefined ? base : patch) as T;
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (value === null) delete out[key];
    else if (value === undefined) continue;
    else if (isPlain(value) && isPlain(out[key])) out[key] = deepMerge(out[key], value);
    else out[key] = structuredClone(value);
  }
  return out as T;
}

/** A known settings section, also an optional one without defaults (e.g. lifecycle) – service.ts loads those too. */
export const isSettingsSection = (name: string): boolean => Object.prototype.hasOwnProperty.call(KEYS, name);

/** Sections older versions had: left out of settings.json quietly, like an unknown key. */
export const RETIRED_SECTIONS: ReadonlySet<string> = new Set(['org']);

/** The keys of `value` that section `section` does not know (settings.json leaves them out and says so). */
export function unknownKeys(section: string, value: Record<string, unknown>): string[] {
  if (FREE.has(section)) return [];
  const keys = isSettingsSection(section) ? KEYS[section] : [];
  return Object.keys(value).filter((key) => !keys.includes(key));
}

/** Rejects unknown sections/keys so typos never silently persist. */
export function checkPatchShape(patch: unknown): void {
  if (!isPlain(patch)) bad('(root)', 'an object');
  for (const [section, value] of Object.entries(patch)) {
    const keys = Object.prototype.hasOwnProperty.call(KEYS, section) ? KEYS[section] : undefined;
    if (!keys) bad(section, 'a known settings section');
    if (!isPlain(value)) bad(section, 'an object');
    if (FREE.has(section)) continue;
    for (const key of Object.keys(value)) if (!keys.includes(key)) bad(`${section}.${key}`, 'a known key');
  }
}

const str = (value: unknown, path: string, max = 120, allowEmpty = true): void => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f]/.test(value) || (!allowEmpty && !value.trim())) bad(path, `text up to ${max} characters`);
};
const optStr = (value: unknown, path: string, max = 200): void => { if (value !== undefined) str(value, path, max); };
const boolean = (value: unknown, path: string): void => { if (typeof value !== 'boolean') bad(path, 'true or false'); };
/** One of the defined options of `path` (schema.ts). */
const oneOf = (value: unknown, path: string): void => { const options = optionsOf(path); if (!options.includes(value as never)) bad(path, options.join(' | ')); };
/** A whole number in the defined range of `path` (schema.ts). */
const intIn = (value: unknown, path: string): void => {
  const [min, max] = rangeOf(path);
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) bad(path, `an integer ${min}..${max}`);
};
/** A list of distinct defined options of `path` (schema.ts). */
const subset = (value: unknown, path: string): void => {
  const options = optionsOf(path);
  if (!Array.isArray(value) || value.some((item) => !options.includes(item)) || new Set(value).size !== value.length) bad(path, `a list of ${options.join(', ')}`);
};

function validTimezone(zone: unknown): boolean {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; }
}

/** AF-002: first-run steps of older versions; a first run that stopped on one goes on at 'profile'. */
const LEGACY_STEPS: ReadonlySet<string> = new Set(['tour', 'about', 'team', 'voice']);
const TOUR_ID = new RegExp(PATTERNS.tourStep);

/** AF-002: the spotlight tour's keys of the onboarding section (absent = their default). */
function validateTour(o: Settings['onboarding']): void {
  if (o.tour !== undefined) oneOf(o.tour, 'onboarding.tour');
  if (o.tourStep !== undefined && (typeof o.tourStep !== 'string' || !TOUR_ID.test(o.tourStep))) bad('onboarding.tourStep', 'a step id or ""');
  if (o.hints !== undefined && (!Array.isArray(o.hints) || o.hints.length > MAX_HINTS || o.hints.some((id) => typeof id !== 'string' || !id || !TOUR_ID.test(id)))) bad('onboarding.hints', `a list of up to ${MAX_HINTS} area ids`);
}

const HHMM = new RegExp(PATTERNS.clock);
const LANGUAGE = new RegExp(PATTERNS.language);
const GOOGLE_CLIENT_ID = new RegExp(PATTERNS.googleClientId);

/** Validates a complete Settings object (after merging). Throws WorkforceError('bad_request'). */
export function validateSettings(s: Settings): void {
  const p = s.profile;
  str(p.name, 'profile.name');
  str(p.company, 'profile.company', 200);
  optStr(p.avatarFileId, 'profile.avatarFileId', 80);
  if (typeof p.language !== 'string' || !LANGUAGE.test(p.language)) bad('profile.language', 'a language code like "en" or "de"');
  if (!validTimezone(p.timezone)) bad('profile.timezone', 'an IANA time zone');
  // B-078: the AI's note (line breaks and tabs are fine, other control characters are not)
  if (p.notes !== undefined && (typeof p.notes !== 'string' || p.notes.length > NOTES_MAX || /[\u0000-\u0008\u000b-\u001f]/.test(p.notes))) bad('profile.notes', `text up to ${NOTES_MAX} characters`);

  const ui = s.preferences;
  oneOf(ui.theme, 'preferences.theme');
  intIn(ui.sidebarWidth, 'preferences.sidebarWidth');
  intIn(ui.workspaceWidth, 'preferences.workspaceWidth');
  for (const key of ['sidebarOpen', 'workspaceOpen', 'enterSends', 'closeToTray', 'openAtLogin', 'autoDownloadUpdates'] as const) boolean(ui[key], `preferences.${key}`);

  const n = s.notifications;
  boolean(n.enabled, 'notifications.enabled');
  boolean(n.sound, 'notifications.sound');
  subset(n.pushFor, 'notifications.pushFor');
  if (n.quietHours !== undefined) {
    if (!isPlain(n.quietHours) || !HHMM.test(String(n.quietHours.from)) || !HHMM.test(String(n.quietHours.to)) || Object.keys(n.quietHours).length !== 2) {
      bad('notifications.quietHours', '{ from: "HH:MM", to: "HH:MM" }');
    }
  }

  const v = s.voice;
  optStr(v.ttsVoice, 'voice.ttsVoice');
  oneOf(v.realtime, 'voice.realtime');
  if (v.talker !== undefined) boolean(v.talker, 'voice.talker');
  for (const [key, purpose] of [['localStt', 'stt'], ['localTts', 'tts']] as const) { // B-047 D14: '' = none
    const id = v[key];
    if (id !== undefined && id !== '' && (typeof id !== 'string' || !localSpeechModel(id, purpose))) bad(`voice.${key}`, `'' or one of ${localSpeechIds(purpose).join(', ')}`);
  }
  if (!Array.isArray(v.vocabulary) || v.vocabulary.length > MAX_WORDS) bad('voice.vocabulary', `a list of up to ${MAX_WORDS} terms`);
  v.vocabulary = v.vocabulary.map((entry: unknown) => (isPlain(entry) ? entry.term : entry) as string); // older files: {term, soundsLike, pronounce}
  for (const term of v.vocabulary) str(term, 'voice.vocabulary', 120, false);

  validateRouting(s.routing, bad); // the Models section: the uses, cost mode, paid fallback (routing/uses-settings.ts)
  if (s.providers !== undefined) validateProviders(s.providers);

  boolean(s.onboarding.completed, 'onboarding.completed');
  const step = s.onboarding.step as string;
  if (LEGACY_STEPS.has(step)) s.onboarding.step = 'profile'; // AF-002: older first runs that stopped there go on at the assistant's first step
  oneOf(s.onboarding.step, 'onboarding.step'); // B-044 first run
  validateTour(s.onboarding); // AF-002: the spotlight tour's state
  boolean(s.feedback.includeDiagnostics, 'feedback.includeDiagnostics');
  if (s.library !== undefined) { if (!isPlain(s.library)) bad('library', 'an object'); boolean(s.library.publish, 'library.publish'); } // B-078
  boolean(s.pwa.enabled, 'pwa.enabled');
  oneOf(s.pwa.bind, 'pwa.bind');
  oneOf(s.devices.peer, 'devices.peer');
  intIn(s.devices.peerPort, 'devices.peerPort'); // 0 = any free port
  if (s.devices.findable !== undefined) boolean(s.devices.findable, 'devices.findable'); // Remote (absent = on)
  if (s.devices.relay !== undefined && (typeof s.devices.relay !== 'string' || (s.devices.relay !== '' && relayAddress(s.devices.relay) !== s.devices.relay))) bad('devices.relay', 'a relay address (wss://…) or empty');
  if (s.lifecycle !== undefined) validateLifecycle(s.lifecycle); // LIFECYCLE: retention days
  if (s.day !== undefined) validateDay(s.day);
  if (s.calendar !== undefined) {
    if (!isPlain(s.calendar)) bad('calendar', 'an object');
    if (s.calendar.googleClientId !== undefined && (typeof s.calendar.googleClientId !== 'string' || !GOOGLE_CLIENT_ID.test(s.calendar.googleClientId))) bad('calendar.googleClientId', 'a Google OAuth client id');
    optStr(s.calendar.googleSecretId, 'calendar.googleSecretId', 80);
  }
}

/** The API connections: each entry's shape (shared/model/provider-entries.ts), and a url the engines will take. */
function validateProviders(providers: NonNullable<Settings['providers']>): void {
  if (!isPlain(providers)) bad('providers', 'an object with one entry per connection');
  for (const [id, entry] of Object.entries(providers)) {
    const problem = entryProblem(id, entry);
    if (problem) bad(`providers.${id}`, problem);
    const connection = entryConnection(id, entry);
    if ('problem' in connection || !connection.baseUrl) continue;
    try { endpointFor(connection); } catch (error) { bad(`providers.${id}.url`, error instanceof Error ? error.message : 'a valid server URL'); }
  }
}

/** B-041 Settings › day: working hours (start before end), the planning buffer, the morning plan, the switches. */
function validateDay(day: NonNullable<Settings['day']>): void {
  if (!isPlain(day)) bad('day', 'an object');
  for (const key of ['workStart', 'workEnd', 'planAt'] as const) if (typeof day[key] !== 'string' || !HHMM.test(day[key])) bad(`day.${key}`, 'a time as "HH:MM"');
  if (clockMinutes(day.workStart)! >= clockMinutes(day.workEnd)!) bad('day.workEnd', 'a time after day.workStart');
  intIn(day.bufferMin, 'day.bufferMin');
  for (const key of ['autoPlan', 'aiHelps', 'keepAwake', 'agentLane'] as const) boolean(day[key], `day.${key}`);
}
