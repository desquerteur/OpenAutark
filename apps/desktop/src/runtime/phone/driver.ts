// The PhoneDriver seam: what phone tools need from whatever drives an Android phone. AdbPhone
// (adb.ts, USB or wireless debugging) is the driver today; wireless pairing is ADB-specific
// (PhoneWireless).
// Owns: the interface and its small value types. Never: behaviour.

import type { NearbyPhone } from '../../shared/model/phone.ts';
import type { PhoneDevice, PhoneNode } from './uiautomator.ts';

export interface PhoneStepOptions {
  /** Ends the step before its next command (a cancelled run). */
  signal?: AbortSignal;
}

export interface PhoneShot { serial: string; data: Uint8Array; mime: string; width: number; height: number; scale: number; screen: { width: number; height: number } }
export interface PhoneTree { serial: string; text: string; count: number; truncated: boolean; nodes: PhoneNode[]; screen?: { width: number; height: number } }

export interface PhoneDriver {
  available(): Promise<boolean>;
  devices(): Promise<PhoneDevice[]>;
  screenshot(serial?: string, step?: PhoneStepOptions): Promise<PhoneShot>;
  uiTree(serial?: string, step?: PhoneStepOptions): Promise<PhoneTree>;
  tap(serial: string | undefined, x: number, y: number, step?: PhoneStepOptions): Promise<void>;
  swipe(serial: string | undefined, from: { x: number; y: number }, to: { x: number; y: number }, durationMs?: number, step?: PhoneStepOptions): Promise<void>;
  type(serial: string | undefined, value: string, step?: PhoneStepOptions): Promise<void>;
  /** Presses a key; returns the key code it sent. */
  key(serial: string | undefined, name: string, step?: PhoneStepOptions): Promise<string>;
  open(serial: string | undefined, target: { url?: string; package?: string }, step?: PhoneStepOptions): Promise<string>;
}

/** Wireless debugging (ADB only): pairing with the phone's code, connecting, phones nearby. */
export interface PhoneWireless {
  pair(address: string, code: string): Promise<{ address: string; name?: string }>;
  connect(address: string): Promise<{ address: string; already: boolean }>;
  disconnect(serial: string): Promise<{ serial: string; was: boolean }>;
  discover(): Promise<NearbyPhone[]>;
}
