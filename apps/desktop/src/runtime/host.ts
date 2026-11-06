// The runtime's view of its host process (Electron main, or plain Node for headless/tests).
// Owns: the small set of capabilities only the host can provide (including restarting the
// runtime process, where the host can, and video keyframes from a hidden window, MM4).
// Never: lets the runtime import `electron` – everything Electron-specific comes through here.

import type { AppInfo, DecodedAudio, HostOps, ImageRegion, Keyframes, NormalizedImage, PowerEvent } from '../shared/api/host-bridge.ts';
import type { SideBrowserCall, SideBrowserResult } from '../shared/model/side-browser.ts'; // B-055
import type { CompanyStart } from '../shared/model/companies.ts'; // B-078

/** MM4: video understanding through the host's own media stack. */
export interface HostMedia {
  /**
   * Up to KEYFRAME_LIMITS.frames keyframes of a stored video (blob id): the opening shot, the
   * biggest scene changes, then even coverage; JPEG ≤ 768 px with timestamps, in time order.
   * Rejects with a user-safe WorkforceError (format not supported, no picture, timeout, busy).
   */
  keyframes(input: { fileId: string; mime?: string; frames: number }): Promise<Keyframes>;
  /**
   * B-058 G6: any recording or video the window can decode (blob id) as 16 kHz mono PCM16, from `startMs`
   * for at most `maxMs` (AUDIO_DECODE_LIMITS; a long MP3/OGG/WebM is read only up to the span, MP4/M4A/MOV
   * whole up to 30 min; no span may end after minute 30 of a longer file – the decode holds all the sound from
   * the start). Missing on hosts without app windows; callers go through runtime/media/hear-any.ts.
   * Rejects with a user-safe WorkforceError (no sound track, format not supported, too long, timeout, busy).
   */
  audio?(input: { fileId: string; mime?: string; startMs?: number; maxMs?: number }): Promise<DecodedAudio>;
  /**
   * B-058 G10: a stored image (JPEG, PNG, WebP, GIF, BMP, AVIF, ICO, SVG; EXIF rotation applied) as JPEG/PNG
   * ≤ maxPx on its longest edge (IMAGE_LIMITS; never scaled up, except SVG), optionally a region (fractions
   * 0..1). Missing on hosts without app windows; rejects with a user-safe WorkforceError (HEIC/TIFF not supported).
   */
  image?(input: { fileId: string; mime?: string; maxPx?: number; region?: ImageRegion }): Promise<NormalizedImage>;
}

export interface HostCapture {
  /** PNG/JPEG bytes of a display (index) or of the app window ('app'). */
  screenshot(target: { display?: number; window?: 'app' }, format?: 'png' | 'jpeg'): Promise<{ data: Uint8Array; width: number; height: number; mime: string }>;
  displays(): Promise<Array<{ index: number; width: number; height: number; scale: number; primary: boolean }>>;
}

export interface Host {
  kind: 'electron' | 'node';
  /** Encrypts small secrets with the OS keychain (Electron safeStorage / DPAPI). */
  encrypt(plain: string): Promise<Uint8Array>;
  decrypt(cipher: Uint8Array): Promise<string>;
  /** Native notification; resolves true when clicked. */
  notify(input: { title: string; body: string; silent?: boolean; tag?: string }): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  openPath(path: string, reveal?: boolean): Promise<void>;
  capture?: HostCapture; // missing on headless hosts without a display
  /** MM4: missing on hosts without app windows (headless) – media.look fails clearly there. */
  media?: HostMedia;
  /** B-055: an agent works in the person's side browser (shared/model/side-browser.ts; main/side-driver answers); missing on headless hosts. */
  sideBrowser?(call: SideBrowserCall): Promise<SideBrowserResult>;
  /** B-076: a side tab watched from another PC or a phone (main/side-driver/caster.ts; host ops sideCast/sideInput/sideNav); missing on headless hosts. */
  sideView?: {
    cast(args: HostOps['sideCast']['args']): Promise<HostOps['sideCast']['result']>;
    input(args: HostOps['sideInput']['args']): Promise<HostOps['sideInput']['result']>;
    nav(args: HostOps['sideNav']['args']): Promise<HostOps['sideNav']['result']>;
  };
  /** Called by the host on resume/suspend/lock/unlock so timers can re-arm, and (B-044) 'online' when the app window's network came back. */
  onPower(listener: (event: PowerEvent) => void): () => void;
  /** Seconds since last user input on this machine (human-presence for computer use). */
  idleSeconds(): Promise<number>;
  /** Keeps the system awake while long work runs; returns a release function. */
  keepAwake(reason: string): () => void;
  /** Tell the host UI something changed that only the host shows (e.g. tray badge). */
  setBadge?(count: number): void;
  /**
   * MM7: stops this runtime and starts it again (Electron: main restarts the utility process
   * after answering, so the caller's reply still goes out). Missing on hosts that cannot restart
   * themselves (headless: the person or the service manager restarts the process).
   */
  restart?(): Promise<void>;
  /** MM7: long start work is about to run before the runtime is ready (applying a staged restore); the host waits longer. */
  extendBoot?(reason: 'restore'): Promise<void>;
  /** B-072: opens a company on this PC (main/companies.ts): its window opens, this one goes to the tray. Missing headless. */
  openCompany?(input: { id?: string | null; create?: boolean; start?: CompanyStart }): Promise<{ ok: true; id: string | null }>;
  /** App version and whether running packaged; `companies` (B-072): where the companies on this PC live; `start` (B-078): this company's `--start=` flag. */
  app: { version: string; packaged: boolean; resourcesDir: string; dataDir: string; executable: string; companies?: AppInfo['companies']; start?: CompanyStart };
}
