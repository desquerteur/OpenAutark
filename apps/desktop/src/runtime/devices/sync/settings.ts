// settings.json between the CEO's own PCs (op 'settings' of 'sync.file', files.ts): one unit per top-level section
// (key 'settings/<section>', stamps.ts) – every section except what belongs to this PC: devices (its listener,
// requests, meeting server), pwa (who reaches its HTTP port) and the window layout (sidebar and side pane, open and width).
// A section is stamped only when its shared part really changes; one without a stamp gets a baseline at 0 (an older
// single 'settings' stamp counts for every section), so a change in one section never resets another and a PC that
// joins never beats the existing PC with settings nobody changed. The receiver turns a section that wins into a
// settings.update patch (a key the sender no longer has becomes null), so the store checks and announces it like an
// edit – a text cleared on one PC is cleared on the others. A PC that joins takes the existing PC's settings and keeps
// what only it had (at 0 the joiner merges, and an empty or null text there never clears a text it has – its own
// name stays; the merged copy then travels back as its change); a section only the joiner has reaches the other PC.
// API connections (`providers`) travel here; their keys are handles, the values go with the secrets. B-078: profile.notes
// travels as its own unit 'profile.notes' (OWN_UNITS), so PCs on 0.3.2/0.3.3 skip it like the new section library.
// Owns: that cut, the section stamps and the patch. Never: writes settings.json itself or sends to a PC that is no
// 'ceo' link.

import type { RuntimeServices } from '../../contracts.ts';
import type { Settings, SettingsPatch } from '../../../shared/model/system.ts';
import { isSettingsSection } from '../../settings/validate.ts';
import { hashOf, wins, type Stamp, type Stamps } from './stamps.ts';

/**
 * B-078 compatibility (CONTRACT rule 9): a key added to a section that PCs on 0.3.2/0.3.3 know travels as its own unit
 * ('<section>.<key>'). Such a PC skips a unit it does not know quietly (receive below), so its store never sees the key
 * (it refuses a patch naming one, settings/validate.ts checkPatchShape); its copies of the section lack the key and the
 * section's hash stays what it was, so they never clear the key here. A new section (library) is skipped the same way.
 */
const OWN_UNITS: Readonly<Record<string, readonly [section: string, key: string]>> = { 'profile.notes': ['profile', 'notes'] };
const isUnit = (name: string): boolean => Object.prototype.hasOwnProperty.call(OWN_UNITS, name);

const PREFIX = 'settings/';
/** The single stamp of older versions (the whole file). */
const LEGACY = 'settings';
const LOCAL_SECTIONS: ReadonlySet<string> = new Set(['devices', 'pwa']);
const LAYOUT = ['sidebarOpen', 'sidebarWidth', 'workspaceOpen', 'workspaceWidth'];

type Plain = Record<string, unknown>;
const plain = (value: unknown): value is Plain => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const setText = (value: unknown) => typeof value === 'string' && value !== '';
/** A unit that travels between the PCs: a settings section (not this PC's own) or one of OWN_UNITS. */
const synced = (name: string): boolean => !LOCAL_SECTIONS.has(name) && (isSettingsSection(name) || isUnit(name));

/** The part of the settings the CEO's PCs share (OWN_UNITS split out of their sections). */
export function syncedSettings(settings: Settings): Plain {
  const out: Plain = {};
  for (const [section, value] of Object.entries(settings)) {
    if (LOCAL_SECTIONS.has(section) || value === undefined) continue;
    if (section !== 'preferences' || !plain(value)) { out[section] = value; continue; }
    const { ...preferences } = value;
    for (const key of LAYOUT) delete preferences[key];
    out[section] = preferences;
  }
  for (const [unit, [section, key]] of Object.entries(OWN_UNITS)) {
    const value = out[section];
    if (!plain(value)) continue;
    const { [key]: own, ...rest } = value;
    out[section] = rest;
    out[unit] = own ?? null; // a key that is gone travels as null (cleared), like a section key the sender lacks
  }
  return out;
}

/** Adds one section's patch part to `patch` (a unit and its section both write that section). */
function addPart(patch: Plain, section: string, part: Plain): void {
  patch[section] = plain(patch[section]) ? { ...patch[section], ...part } : part;
}

/**
 * What turns `local` into `incoming` for the store's deep merge: changed keys, null for keys `incoming` lacks;
 * `merge` (the first link): those stay, and an empty or null value never replaces a text that is set here.
 */
function diff(local: Plain, incoming: Plain, merge: boolean): Plain {
  const out: Plain = {};
  for (const key of new Set([...Object.keys(local), ...Object.keys(incoming)])) {
    const mine = local[key];
    const theirs = incoming[key];
    if (merge && (theirs === null || theirs === '') && setText(mine)) continue;
    if (theirs === undefined) { if (mine !== undefined && !merge) out[key] = null; continue; }
    if (JSON.stringify(mine) === JSON.stringify(theirs)) continue;
    out[key] = plain(mine) && plain(theirs) ? diff(mine, theirs, merge) : theirs;
  }
  return out;
}

/**
 * The settings.update patch that makes the sections in `incoming` equal there (unknown and local sections left
 * out; a section `incoming` does not name stays as it is); `merge` (the first link): what only this PC has and the
 * texts set here stay.
 */
export function settingsPatch(local: Settings, incoming: Plain, merge = false): SettingsPatch {
  const mine = syncedSettings(local);
  const patch: Plain = {};
  for (const section of Object.keys(incoming)) {
    if (!synced(section)) continue;
    if (isUnit(section)) {
      const [name, key] = OWN_UNITS[section]!;
      const theirs = incoming[section];
      if (merge && (theirs === null || theirs === undefined || theirs === '') && setText(mine[section])) continue;
      if (JSON.stringify(mine[section]) !== JSON.stringify(theirs)) addPart(patch, name, { [key]: theirs ?? null });
      continue;
    }
    const change = diff(plain(mine[section]) ? mine[section] : {}, plain(incoming[section]) ? incoming[section] : {}, merge);
    if (Object.keys(change).length) addPart(patch, section, change);
  }
  return patch as SettingsPatch;
}

/** One section as it travels. */
export interface SectionCopy { at: number; h: string; value: unknown }
export interface SettingsMessage { sections: Record<string, SectionCopy> }

const validCopy = (copy: unknown): copy is SectionCopy => plain(copy) && typeof copy.at === 'number' && typeof copy.h === 'string';

export class SettingsSync {
  private readonly s: RuntimeServices;
  private readonly stamps: Stamps;
  /** Sends stamped sections to the CEO PCs (files.ts), `except` the one they came from. */
  private readonly send: (message: SettingsMessage, except?: string) => void;

  constructor(s: RuntimeServices, stamps: Stamps, send: (message: SettingsMessage, except?: string) => void) {
    this.s = s;
    this.stamps = stamps;
    this.send = send;
  }

  /** Stamps what changed while no PC was linked (or baselines), then listens. */
  attach(): () => void {
    this.changed();
    return this.s.bus.on('settings.updated', () => this.changed());
  }

  /** A section's stamp here: its own, else the older single stamp's time with its current hash. */
  private stampOf(section: string, value: unknown): Stamp | undefined {
    const own = this.stamps.get(PREFIX + section);
    if (own) return own;
    const legacy = this.stamps.get(LEGACY);
    return legacy ? { at: legacy.at, h: hashOf(value) } : undefined;
  }

  /** Stamps and sends each section whose shared part changed since its stamp; a section without one gets its baseline. */
  private changed(): void {
    try {
      const shared = syncedSettings(this.s.settings.get());
      const sections: Record<string, SectionCopy> = {};
      for (const [section, value] of Object.entries(shared)) {
        const h = hashOf(value);
        const old = this.stampOf(section, value);
        if (!old) { this.stamps.set(PREFIX + section, { at: 0, h }); continue; } // nothing changed since the link
        if (old.h === h) { if (!this.stamps.get(PREFIX + section)) this.stamps.set(PREFIX + section, old); continue; }
        const stamp = this.stamps.next(old, h);
        this.stamps.set(PREFIX + section, stamp);
        sections[section] = { at: stamp.at, h, value };
      }
      if (this.stamps.get(LEGACY)) this.stamps.drop(LEGACY); // every section has its own stamp now
      if (Object.keys(sections).length) this.send({ sections });
    } catch (error) {
      this.s.log.warn('settings change not synced', { error: String((error as Error)?.message ?? error) });
    }
  }

  /** Every section for a link-up (at 0 when it never changed since the link). */
  current(): SettingsMessage {
    const sections: Record<string, SectionCopy> = {};
    for (const [section, value] of Object.entries(syncedSettings(this.s.settings.get()))) {
      sections[section] = { at: this.stampOf(section, value)?.at ?? 0, h: hashOf(value), value };
    }
    return { sections };
  }

  /** Sections from a CEO PC: each one that wins is applied, then they are passed on. `joined`: this PC joined the sender. */
  receive(message: SettingsMessage, from: string, joined: boolean): void {
    if (!plain(message?.sections)) return;
    const shared = syncedSettings(this.s.settings.get());
    const won: Record<string, SectionCopy> = {};
    for (const [section, copy] of Object.entries(message.sections)) {
      if (!validCopy(copy) || !synced(section)) continue;
      // A section this PC never had is taken as it comes (also a joiner's at 0).
      const local = this.stampOf(section, shared[section]) ?? (shared[section] === undefined ? undefined : { at: 0, h: hashOf(shared[section]) });
      if (local?.h !== copy.h && wins({ at: copy.at, h: copy.h }, local, joined)) won[section] = copy;
    }
    const names = Object.keys(won);
    if (!names.length) return;
    const before = new Map(names.map((section) => [section, this.stamps.get(PREFIX + section)]));
    // First the stamps: the store's settings.updated then finds a change only where this PC keeps something.
    for (const section of names) this.stamps.set(PREFIX + section, { at: won[section].at, h: won[section].h });
    try {
      const patch: Plain = {};
      // At the first link (both at 0) the joiner merges: what only it had and its texts stay and go back as its own change.
      for (const section of names) {
        const part = settingsPatch(this.s.settings.get(), { [section]: won[section].value }, won[section].at === 0) as Plain;
        for (const [name, value] of Object.entries(part)) addPart(patch, name, value as Plain);
      }
      if (Object.keys(patch).length) this.s.settings.update(patch as SettingsPatch);
    } catch (error) {
      for (const [section, stamp] of before) { if (stamp) this.stamps.set(PREFIX + section, stamp); else this.stamps.drop(PREFIX + section); }
      throw error;
    }
    this.changed(); // what a joiner kept at the merge travels back, also when nothing else changed here
    this.send({ sections: won }, from);
  }
}
