// Camera and microphone choice for the `record` widget (P12: a plugged-in camera is usable).
// Lists the devices once access was allowed (before that, browsers hide names and ids), keeps
// the person's choice per mode in localStorage (guarded: storage may be blocked) and pre-selects
// a newly plugged-in camera ("New camera found"): on 'devicechange' while a preview is live, or
// at the next preview when it came while none was. Chromium's virtual 'default'/'communications'
// microphones are left out (they repeat a real one), so one camera and one microphone never show
// a choice (P25).
// The take guard lives here too: which record widgets (by draft key) are recording or hold an
// unsent take, so the For-you list keeps them open and asks "Discard recording?" first.
// Owns: the device list, the remembered deviceId per mode, the devicechange listener and the
// take guard registry.
// Never: opens a stream (recorder.ts does), remembers anything but device ids, listens or arms
// media while no preview is live (idle, recording, a take waiting, an error) or after dispose().

import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { dropTake } from '../../pwa/idb.ts';
import type { RecorderState } from './recorder.ts';

export type CaptureMode = 'audio' | 'video';

export interface CaptureDevice {
  id: string;
  label: string;
}

/** What the device select shows. */
export interface DeviceChoice {
  /** Connected devices of the mode's kind; empty until access was allowed. */
  devices: CaptureDevice[];
  /** The device in use or to use next; undefined = the system default. */
  selected?: string;
  /** A camera plugged in while the widget was open and pre-selected ("New camera found"). */
  added?: string;
}

export interface DeviceInfo {
  deviceId: string;
  kind: string;
  label: string;
  groupId?: string;
}

/** The part of navigator.mediaDevices used here (a fake in tests). */
export interface MediaDevicesLike {
  enumerateDevices(): Promise<DeviceInfo[]>;
  addEventListener(type: 'devicechange', listener: () => void): void;
  removeEventListener(type: 'devicechange', listener: () => void): void;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KIND: Record<CaptureMode, string> = { audio: 'audioinput', video: 'videoinput' };
const VIRTUAL = new Set(['default', 'communications']);
const STORAGE_KEY = 'wf.recorder.device.';

function localStore(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function rememberedDevice(mode: CaptureMode, storage: StorageLike | null = localStore()): string | undefined {
  try { return storage?.getItem(STORAGE_KEY + mode) || undefined; } catch { return undefined; }
}

export function rememberDevice(mode: CaptureMode, id: string, storage: StorageLike | null = localStore()): void {
  try { storage?.setItem(STORAGE_KEY + mode, id); } catch { /* blocked or full: the choice holds for this widget only */ }
}

/** Real devices of the mode's kind in the browser's order; entries without an id (no access) are left out. */
export function devicesOf(all: readonly DeviceInfo[], mode: CaptureMode): CaptureDevice[] {
  const noun = mode === 'audio' ? 'Microphone' : 'Camera';
  return all
    .filter((device) => device.kind === KIND[mode] && device.deviceId && !VIRTUAL.has(device.deviceId))
    .map((device, index) => ({ id: device.deviceId, label: device.label || `${noun} ${index + 1}` }));
}

/** The real device behind an id: Chromium reports the default microphone as 'default' (same groupId). */
export function realDevice(all: readonly DeviceInfo[], mode: CaptureMode, id: string | undefined): string | undefined {
  if (!id || !VIRTUAL.has(id)) return id;
  const group = all.find((device) => device.kind === KIND[mode] && device.deviceId === id)?.groupId;
  if (!group) return undefined;
  return all.find((device) => device.kind === KIND[mode] && device.groupId === group && !VIRTUAL.has(device.deviceId))?.deviceId;
}

/** The wanted device while it is connected, else undefined (the system default). */
export function preferredDevice(devices: readonly CaptureDevice[], wanted: string | undefined): string | undefined {
  return wanted && devices.some((device) => device.id === wanted) ? wanted : undefined;
}

/** Devices in `after` that were not in `before`; none while `before` is not known yet. */
export function addedDevices(before: readonly CaptureDevice[], after: readonly CaptureDevice[]): CaptureDevice[] {
  if (!before.length) return [];
  const known = new Set(before.map((device) => device.id));
  return after.filter((device) => !known.has(device.id));
}

/** A deliberate device choice is exact; media-stream.ts falls back when it disappeared. */
export function deviceConstraint(id: string | undefined): { deviceId?: { exact: string } } {
  return id ? { deviceId: { exact: id } } : {};
}

export interface DeviceChooser {
  readonly choice: DeviceChoice;
  /** The device to open: the chosen one, else the remembered one (undefined: the system default). */
  wanted(): string | undefined;
  /**
   * A preview opened (access allowed): lists the devices, `inUse` being the stream's device, and
   * pre-selects a camera that came since the last list. Listens to 'devicechange' until pause().
   */
  refresh(inUse?: string): Promise<void>;
  /** The preview closed or a take started: changes wait for the next refresh() (no arm, no choice). */
  pause(): void;
  /** The person picked a device: it is used and remembered for this mode. */
  choose(id: string): void;
  dispose(): void;
}

export interface ChooserOptions {
  media: MediaDevicesLike;
  /** Defaults to localStorage; null keeps nothing. */
  storage?: StorageLike | null;
  /** Start from the remembered device (false while the block asks for a front/back camera). */
  remembered?: boolean;
  /** A change in a live preview found the names withheld: allow reading this kind again (desktop: armMedia). */
  arm?: (kinds: CaptureMode[]) => Promise<void>;
  /** `switched`: the device to use changed by itself (a new camera, or the chosen one went away). */
  onChange(choice: DeviceChoice, switched: boolean): void;
}

export function createDeviceChooser(mode: CaptureMode, options: ChooserOptions): DeviceChooser {
  const storage = options.storage === undefined ? localStore() : options.storage;
  const useRemembered = options.remembered !== false;
  let choice: DeviceChoice = { devices: [], selected: useRemembered ? rememberedDevice(mode, storage) : undefined };
  let listening = false;
  let disposed = false;
  let latest = 0;
  /** Bumped by every refresh() and pause(): work started before it no longer applies. */
  let session = 0;
  const set = (next: DeviceChoice, switched: boolean) => { choice = next; options.onChange(next, switched); };
  /** One enumeration; null when a newer one started meanwhile or the chooser is gone. */
  const list = async (): Promise<DeviceInfo[] | null> => {
    const run = ++latest;
    const all = await options.media.enumerateDevices().catch(() => null);
    return all && run === latest && !disposed ? all : null;
  };
  /**
   * A new list. A camera that was not in the last one is pre-selected and remembered ("New camera
   * found"); otherwise `inUse` stays, and with `follow` an unplugged choice falls back to the default.
   */
  const apply = (devices: CaptureDevice[], inUse: string | undefined, follow: boolean) => {
    const added = mode === 'video' ? addedDevices(choice.devices, devices).at(-1)?.id : undefined;
    if (added) {
      rememberDevice(mode, added, storage);
      set({ devices, selected: added, added }, added !== inUse);
      return;
    }
    const selected = preferredDevice(devices, inUse) ?? preferredDevice(devices, choice.selected);
    set({ devices, selected, added: preferredDevice(devices, choice.added) }, follow && selected !== choice.selected);
  };

  // Only while a preview is live (refresh() … pause()): the person opened the device by a click.
  // Names withheld (desktop: that click's arm ran out) arm this one kind once and list again.
  const changed = async () => {
    const mine = session;
    let all = await list();
    if (all && !devicesOf(all, mode).length && options.arm && mine === session) {
      try { await options.arm([mode]); } catch { /* not on this host */ }
      all = mine === session ? await list() : null;
    }
    const devices = all && mine === session ? devicesOf(all, mode) : [];
    if (devices.length) apply(devices, choice.selected, true); // none: names withheld, keep the last list
  };
  const onDeviceChange = () => { void changed(); };
  const listen = (on: boolean) => {
    if (on === listening || (on && disposed)) return;
    listening = on;
    if (on) options.media.addEventListener('devicechange', onDeviceChange);
    else options.media.removeEventListener('devicechange', onDeviceChange);
  };

  return {
    get choice() { return choice; },
    wanted: () => choice.selected ?? (useRemembered ? rememberedDevice(mode, storage) : undefined),
    async refresh(inUse) {
      const mine = ++session;
      const all = await list();
      const devices = all ? devicesOf(all, mode) : [];
      if (!all || !devices.length || mine !== session) return;
      listen(true); // before apply(): a switch it causes reopens the preview, which pauses first
      apply(devices, realDevice(all, mode, inUse), false);
    },
    pause() {
      session++;
      listen(false);
    },
    choose(id) {
      if (!choice.devices.some((device) => device.id === id)) return;
      rememberDevice(mode, id, storage);
      set({ ...choice, selected: id, added: undefined }, false);
    },
    dispose() {
      session++;
      listen(false);
      disposed = true;
    },
  };
}

function browserDevices(): MediaDevicesLike | null {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') return null;
  return navigator.mediaDevices;
}

/** One chooser per record widget (none for screen recordings or without media devices). */
export function useDeviceChoice(mode: CaptureMode | null, options: { remembered: boolean; arm: (kinds: CaptureMode[]) => Promise<void>; onSwitch: () => void }) {
  const [choice, setChoice] = useState<DeviceChoice>({ devices: [] });
  const onSwitch = useRef(options.onSwitch);
  onSwitch.current = options.onSwitch;
  const [chooser] = useState(() => {
    const media = mode ? browserDevices() : null;
    return mode && media ? createDeviceChooser(mode, {
      media, remembered: options.remembered, arm: options.arm,
      onChange: (next, switched) => { setChoice(next); if (switched) onSwitch.current(); },
    }) : null;
  });
  useEffect(() => () => chooser?.dispose(), [chooser]);
  return { choice, chooser };
}

// ------------------------------------------------------------------ take guard

/** A take is at stake while recording and while a recorded take is not sent yet. */
export function takeBusy(state: RecorderState, hasTake: boolean): boolean {
  return state === 'recording' || (state === 'recorded' && hasTake);
}

/** Draft keys of record widgets that are recording or hold an unsent take. */
export const heldTakes = signal<ReadonlySet<string>>(new Set());
const holders = new Map<string, Map<object, () => void>>();

/** A widget (`holder`) holds the take of `key`; `discard` drops it without keeping it. */
export function holdTake(key: string, holder: object, discard: () => void): void {
  const widgets = holders.get(key) ?? new Map<object, () => void>();
  widgets.set(holder, discard);
  holders.set(key, widgets);
  heldTakes.value = new Set(holders.keys());
}

export function releaseTake(key: string, holder: object): void {
  const widgets = holders.get(key);
  if (!widgets?.delete(holder)) return;
  if (!widgets.size) holders.delete(key);
  heldTakes.value = new Set(holders.keys());
}

/** "Discard recording?" confirmed: every widget on that key drops its take, and the stored copy goes. */
export function discardTake(key: string): void {
  for (const discard of [...(holders.get(key)?.values() ?? [])]) discard();
  void dropTake(key);
}

/** A list cut to `limit` (Home shows five) that still keeps every held item, in order. */
export function limitKeepingHeld<T>(items: readonly T[], limit: number | undefined, held: (item: T) => boolean): T[] {
  return limit ? items.filter((item, index) => index < limit || held(item)) : [...items];
}
