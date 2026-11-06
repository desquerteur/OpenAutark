// The Host implementation in main: answers the runtime's host-bridge requests (HostOps in
// src/shared/api/host-bridge.ts) with Electron capabilities.
// Owns: argument checks per op, safeStorage refusal rules, the notification lifecycle (click → show window +
// navigate) and its sound (one per burst, a beep while the window has focus), the link allowlist, power-save
// blockers held for the runtime, badge, and handing media jobs to the hidden media analyzer (media-analyzer.ts) and
// a company switch to companies.ts (B-072), and a watched side tab's ops to main/side-driver/caster.ts (B-076).
// Never: restarts the runtime (runtime.restart/booting are RuntimeHost's), imports electron
// (objects are injected so tests use fakes), logs secrets or cipher bytes, opens anything but
// http(s)/mailto links, keeps a blocker after the runtime is gone.

import type { NavigateRequest } from '../shared/api/desktop.ts';
import type { HostOp, HostOps, HostRequest, Keyframes } from '../shared/api/host-bridge.ts';
import { WorkforceError } from '../shared/errors.ts';
import { isId } from '../shared/ids.ts';
import { SCREEN_ON_REASON } from '../shared/model/day-settings.ts'; // B-078
import { ownBytes, type DisplayInfo, type Shot } from './capture.ts';
import { keyframeRequest, type KeyframeRequest } from './media-keyframes.ts';
import { audioRequest, type AudioRequest } from './media-audio.ts'; // B-058 T2
import { imageRequest, type ImageRequest } from './media-image.ts';
import { externalUrl } from './security.ts';
import type { SideBrowserCall, SideBrowserResult } from '../shared/model/side-browser.ts'; // B-055

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(plain: string): Uint8Array;
  decryptString(cipher: Buffer): string;
}

export interface NotificationLike {
  on(event: 'click' | 'close' | 'failed', listener: () => void): unknown;
  show(): void;
  close(): void;
}

export interface HostServicesDeps {
  safeStorage: SafeStorageLike;
  shell: { openExternal(url: string): Promise<void>; openPath(path: string): Promise<string>; showItemInFolder(path: string): void; beep(): void };
  idleSeconds(): number; // powerMonitor.getSystemIdleTime
  powerSaveBlocker: { start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number; stop(id: number): unknown };
  /** null when the OS has no notification service. */
  createNotification(options: { title: string; body: string; silent: boolean }): NotificationLike | null;
  setBadgeCount(count: number): unknown;
  capture: {
    screenshot(target: { display?: number; window?: 'app' }, format?: 'png' | 'jpeg'): Promise<Shot>;
    displays(): DisplayInfo[];
  };
  /** MM4: the hidden media analyzer (MediaAnalyzer); missing = no video keyframes in this build. B-058: also sound decoding and image preparation. */
  media?: {
    analyze(request: KeyframeRequest): Promise<Keyframes>;
    audio?(request: AudioRequest): Promise<HostOps['media.audio']['result']>;
    image?(request: ImageRequest): Promise<HostOps['media.image']['result']>;
  };
  /** B-055: agents in the person's side browser (main/side-driver); missing = 'unavailable'. */
  sideBrowser?: (call: SideBrowserCall) => Promise<SideBrowserResult>;
  /** B-076: a side tab watched from another PC or a phone (main/side-driver/caster.ts checks every field); missing = 'unavailable'. */
  sideView?: { cast(args: unknown): Promise<Result<'sideCast'>>; input(args: unknown): Promise<Result<'sideInput'>>; nav(args: unknown): Promise<Result<'sideNav'>> };
  window: {
    /** True while the user looks at the app (the UI shows the item itself and a beep sounds, no OS toast). */
    focused(): boolean;
    show(): void;
    navigate(request: NavigateRequest): void;
  };
  onBadge?(count: number): void; // tray tooltip
  /** B-072: opens a company on this PC (companies.ts checks the args); missing = 'unavailable' (a test profile). */
  openCompany?(args: HostOps['company.open']['args']): HostOps['company.open']['result'];
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

/** The runtime waits up to 10 min for `notify`; answer "not clicked" before that. */
export const NOTIFY_WAIT_MS = 9 * 60_000;
const KEEP_NOTIFICATIONS = 20; // live objects (a collected Notification loses its click handler)
const SOUND_GAP_MS = 3000; // at most one sound in this time: a burst of notifications sounds once
const MAX_BLOCKERS = 32;
const MAX_SECRET = 1024 * 1024;

type Args<O extends HostOp> = HostOps[O]['args'];
type Result<O extends HostOp> = HostOps[O]['result'];

function bad(message: string): never {
  throw new WorkforceError('bad_request', message);
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') bad(`Invalid ${name}.`);
  return value.slice(0, max);
}

/** Where a notification click leads: explicit ids, else the tag (task id or chat id). */
export function navigateTarget(args: { conversationId?: unknown; taskId?: unknown; tag?: unknown }): NavigateRequest | null {
  const request: NavigateRequest = {};
  if (isId(args.conversationId, 'ch')) request.conversationId = args.conversationId;
  if (isId(args.taskId, 'task')) request.taskId = args.taskId;
  if (!request.conversationId && !request.taskId) {
    if (isId(args.tag, 'task')) request.taskId = args.tag;
    else if (isId(args.tag, 'ch')) request.conversationId = args.tag;
  }
  return request.conversationId || request.taskId ? request : null;
}

export class HostServices {
  private readonly deps: HostServicesDeps;
  private readonly blockers = new Set<number>();
  private notifications: Array<{ tag?: string; notification: NotificationLike }> = [];
  private soundAt = -Infinity; // when a notification last sounded

  constructor(deps: HostServicesDeps) {
    this.deps = deps;
  }

  /** RuntimeHost's `handle`: one host-bridge request → its result (throws WorkforceError). */
  async handle(request: HostRequest): Promise<unknown> {
    const args = request.args as Record<string, unknown>;
    switch (request.op) {
      case 'encrypt': return this.encrypt(args as Args<'encrypt'>);
      case 'decrypt': return this.decrypt(args as Args<'decrypt'>);
      case 'notify': return this.notify(args as Args<'notify'>);
      case 'openExternal': return this.openExternal(args as Args<'openExternal'>);
      case 'openPath': return this.openPath(args as Args<'openPath'>);
      case 'screenshot': return this.screenshot(args as Args<'screenshot'>);
      case 'displays': return { displays: this.deps.capture.displays() } satisfies Result<'displays'>;
      case 'idleSeconds': return { seconds: Math.max(0, Math.floor(this.deps.idleSeconds())) } satisfies Result<'idleSeconds'>;
      case 'keepAwake': return this.keepAwake(args as Args<'keepAwake'>);
      case 'releaseAwake': return this.releaseAwake(args as Args<'releaseAwake'>);
      case 'setBadge': return this.setBadge(args as Args<'setBadge'>);
      case 'media.analyze': return this.analyze(args as Args<'media.analyze'>);
      // B-058 (T2): decoding any recording/video and normalizing images on the media analyzer.
      case 'media.audio': return this.decodeAudio(args as Args<'media.audio'>);
      case 'media.image': return this.prepareImage(args as Args<'media.image'>);
      case 'sideBrowser': // B-055: main/side-driver answers when wired
        if (!this.deps.sideBrowser) throw new WorkforceError('unavailable', 'The side browser is not available in this window.');
        return this.deps.sideBrowser(args as unknown as Args<'sideBrowser'>); // main/side-driver checks every field
      case 'sideCast': case 'sideInput': case 'sideNav': { // B-076
        const view = this.deps.sideView;
        if (!view) throw new WorkforceError('unavailable', 'The side browser is not available in this window.');
        return request.op === 'sideCast' ? view.cast(args) : request.op === 'sideInput' ? view.input(args) : view.nav(args);
      }
      case 'company.open': // B-072
        if (!this.deps.openCompany) throw new WorkforceError('unavailable', 'Other companies open only in the desktop app.');
        return this.deps.openCompany(args as Args<'company.open'>);
      // MM7: the runtime's own lifecycle is RuntimeHost's – it answers these before `handle` is asked.
      case 'runtime.restart':
      case 'runtime.booting': throw new WorkforceError('unavailable', 'The runtime host answers this request.');
      default: throw new WorkforceError('bad_request', 'Unknown host operation.');
    }
  }

  /** The runtime exited: blockers it held can never be released by it. */
  releaseAll(): void {
    for (const id of this.blockers) {
      try { this.deps.powerSaveBlocker.stop(id); } catch { /* already stopped */ }
    }
    this.blockers.clear();
  }

  private secureStorage(): void {
    if (!this.deps.safeStorage.isEncryptionAvailable()) throw new WorkforceError('unavailable', 'Secure storage is not available on this system.');
    let backend: string | undefined;
    try { backend = this.deps.safeStorage.getSelectedStorageBackend?.(); } catch { backend = undefined; }
    // Linux without a keyring: Chromium would "encrypt" with a fixed key – refuse instead.
    if (backend === 'basic_text') throw new WorkforceError('unavailable', 'No system keyring is available, so secrets cannot be stored safely.');
  }

  private encrypt(args: Args<'encrypt'>): Result<'encrypt'> {
    if (typeof args.plain !== 'string' || args.plain.length > MAX_SECRET) bad('Invalid secret.');
    this.secureStorage();
    const cipher = this.deps.safeStorage.encryptString(args.plain);
    return { cipher: ownBytes(cipher) };
  }

  private decrypt(args: Args<'decrypt'>): Result<'decrypt'> {
    const cipher = args.cipher as unknown;
    if (!(cipher instanceof Uint8Array) || cipher.byteLength === 0 || cipher.byteLength > MAX_SECRET * 2) bad('Invalid secret.');
    this.secureStorage();
    try {
      return { plain: this.deps.safeStorage.decryptString(Buffer.from(cipher.buffer, cipher.byteOffset, cipher.byteLength)) };
    } catch {
      throw new WorkforceError('unavailable', 'A stored secret could not be decrypted on this system.');
    }
  }

  private async notify(args: Args<'notify'>): Promise<Result<'notify'>> {
    const title = text(args.title, 'title', 120);
    const body = text(args.body ?? '', 'body', 400);
    const tag = typeof args.tag === 'string' ? args.tag.slice(0, 120) : undefined;
    const target = navigateTarget(args);
    const now = Date.now();
    const sound = args.silent !== true && Math.abs(now - this.soundAt) >= SOUND_GAP_MS; // abs: a clock set back mutes nothing
    if (sound) this.soundAt = now;
    if (this.deps.window.focused()) { // the UI shows it in place; the beep says something came
      if (sound) this.deps.shell.beep();
      return { clicked: false };
    }
    const notification = this.deps.createNotification({ title, body, silent: !sound });
    if (!notification) return { clicked: false };
    this.keep(notification, tag);
    return new Promise(resolve => {
      let done = false;
      let timer: unknown = null;
      const finish = (clicked: boolean) => {
        if (done) return;
        done = true;
        if (timer !== null) this.clearTimer(timer);
        resolve({ clicked });
      };
      notification.on('click', () => {
        // Also works after `finish(false)`: a toast clicked later in the action center still leads there.
        this.deps.window.show();
        if (target) this.deps.window.navigate(target);
        finish(true);
      });
      notification.on('close', () => finish(false));
      notification.on('failed', () => finish(false));
      timer = this.setTimer(() => finish(false), NOTIFY_WAIT_MS);
      try { notification.show(); } catch { finish(false); }
    });
  }

  /** Bounded list of live notifications; a new one with the same tag replaces the old toast. */
  private keep(notification: NotificationLike, tag: string | undefined): void {
    if (tag) {
      for (const entry of this.notifications.filter(item => item.tag === tag)) {
        try { entry.notification.close(); } catch { /* gone */ }
      }
      this.notifications = this.notifications.filter(item => item.tag !== tag);
    }
    this.notifications.push({ tag, notification });
    if (this.notifications.length > KEEP_NOTIFICATIONS) this.notifications = this.notifications.slice(-KEEP_NOTIFICATIONS);
  }

  private async openExternal(args: Args<'openExternal'>): Promise<Result<'openExternal'>> {
    const url = externalUrl(args.url, { mailto: true });
    if (!url) throw new WorkforceError('forbidden', 'Only web and mail links can be opened.');
    await this.deps.shell.openExternal(url);
    return { ok: true };
  }

  private async openPath(args: Args<'openPath'>): Promise<Result<'openPath'>> {
    const target = args.path as unknown;
    if (typeof target !== 'string' || !target || target.length > 4096 || target.includes('\0') || !isAbsolute(target)) bad('Invalid path.');
    if (args.reveal === true) {
      this.deps.shell.showItemInFolder(target);
      return { ok: true };
    }
    const error = await this.deps.shell.openPath(target);
    if (error) throw new WorkforceError('unavailable', 'The file could not be opened.');
    return { ok: true };
  }

  private screenshot(args: Args<'screenshot'>): Promise<Result<'screenshot'>> {
    const target = (args.target ?? {}) as { display?: unknown; window?: unknown };
    const format = args.format === 'jpeg' ? 'jpeg' : 'png';
    if (target.window === 'app') return this.deps.capture.screenshot({ window: 'app' }, format);
    if (target.display !== undefined && !Number.isSafeInteger(target.display)) bad('Invalid display.');
    return this.deps.capture.screenshot({ display: target.display as number | undefined }, format);
  }

  /** MM4: blob id, 1–12 frames and a video MIME type checked here (bad_request), again by the analyzer; never more frames than asked. */
  private async analyze(args: Args<'media.analyze'>): Promise<Result<'media.analyze'>> {
    const request = keyframeRequest(args);
    if (!this.deps.media) throw new WorkforceError('unavailable', 'Video frames are not available in this build of the app.');
    const result = await this.deps.media.analyze(request);
    return { ...result, frames: result.frames.slice(0, request.frames).map((frame) => ({ ...frame, data: ownBytes(frame.data) })) };
  }

  /** B-058 G6: blob id, span and MIME type checked here (bad_request) and again by the analyzer; the PCM in bytes of its own. */
  private async decodeAudio(args: Args<'media.audio'>): Promise<Result<'media.audio'>> {
    const request = audioRequest(args);
    if (!this.deps.media?.audio) throw new WorkforceError('unavailable', 'Decoding recordings is not available in this build of the app.');
    const result = await this.deps.media.audio(request);
    return { ...result, pcm: ownBytes(result.pcm) };
  }

  /** B-058 G10: blob id, edge and region checked here (bad_request) and again by the analyzer; the image in bytes of its own. */
  private async prepareImage(args: Args<'media.image'>): Promise<Result<'media.image'>> {
    const request = imageRequest(args);
    if (!this.deps.media?.image) throw new WorkforceError('unavailable', 'Preparing images is not available in this build of the app.');
    const result = await this.deps.media.image(request);
    return { ...result, data: ownBytes(result.data) };
  }

  private keepAwake(args: Args<'keepAwake'>): Result<'keepAwake'> {
    text(args.reason ?? '', 'reason', 200);
    if (this.blockers.size >= MAX_BLOCKERS) throw new WorkforceError('conflict', 'Too many keep-awake requests are active.');
    // B-078 (D17): running agent turns with day.keepAwake on keep the screen on too (the runtime says so by its reason)
    const id = this.deps.powerSaveBlocker.start(args.reason === SCREEN_ON_REASON ? 'prevent-display-sleep' : 'prevent-app-suspension');
    this.blockers.add(id);
    return { id };
  }

  private releaseAwake(args: Args<'releaseAwake'>): Result<'releaseAwake'> {
    if (!Number.isSafeInteger(args.id)) bad('Invalid id.');
    if (this.blockers.delete(args.id)) {
      try { this.deps.powerSaveBlocker.stop(args.id); } catch { /* already stopped */ }
    }
    return { ok: true };
  }

  private setBadge(args: Args<'setBadge'>): Result<'setBadge'> {
    const count = Number.isFinite(args.count) ? Math.min(99_999, Math.max(0, Math.floor(args.count))) : 0;
    try { this.deps.setBadgeCount(count); } catch { /* unsupported on this platform */ }
    this.deps.onBadge?.(count);
    return { ok: true };
  }

  private setTimer(fn: () => void, ms: number): unknown {
    if (this.deps.setTimer) return this.deps.setTimer(fn, ms);
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  }

  private clearTimer(handle: unknown): void {
    if (this.deps.clearTimer) this.deps.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}

/** Absolute on this OS or the other one (the runtime may pass either style on Windows). */
function isAbsolute(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}
