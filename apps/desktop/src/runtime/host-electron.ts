// Host for the runtime inside Electron's utility process: every Electron-only capability is a
// request to main over process.parentPort (src/shared/api/host-bridge.ts).
// Owns: the runtime side of the host bridge – request ids, timeouts, power listeners and the
// Host object built on top (restart and the longer boot wait are asks to main's RuntimeHost;
// video keyframes, MM4, and – B-058 – decoded sound and prepared images are jobs of main's media
// analyzer, waited for as long as its queue can take).
// Never: imports electron (the parent port is passed in).

import type { Host, HostCapture } from './host.ts';
import { AUDIO_DECODE_LIMITS, IMAGE_LIMITS, KEYFRAME_LIMITS } from '../shared/api/host-bridge.ts';
import type { AppInfo, HostOp, HostOps, HostResponse, PowerEvent } from '../shared/api/host-bridge.ts';
import { WorkforceError } from '../shared/errors.ts';
import { SIDE_WAIT_MAX_MS } from '../shared/model/side-browser.ts'; // B-055

/** The subset of Electron's ParentPort the bridge needs. */
export interface ParentPortLike {
  postMessage(message: unknown): void;
}

/**
 * Main's media analyzer runs one job at a time from one queue (keyframes, sound, images – B-058). Each task holds
 * up to `waiting` + 1 jobs (the running one counted), so any job is done within all of them at their own time
 * (its own included), plus a margin. (Review fix: `waiting` alone left out one job of each other task.)
 */
export const ANALYZER_MS = [KEYFRAME_LIMITS, AUDIO_DECODE_LIMITS, IMAGE_LIMITS].reduce((sum, task) => sum + (task.waiting + 1) * task.jobMs, 0) + 15_000;

const TIMEOUTS: Partial<Record<HostOp, number>> = {
  screenshot: 20_000, notify: 10 * 60_000,
  'media.analyze': ANALYZER_MS, 'media.audio': ANALYZER_MS, 'media.image': ANALYZER_MS,
  sideBrowser: SIDE_WAIT_MAX_MS + 15_000, // B-055: a browser.wait or a 20-step batch in the side browser
};

export class HostBridgeClient {
  private readonly port: ParentPortLike;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly power = new Set<(event: PowerEvent) => void>();
  private next = 1;

  constructor(port: ParentPortLike) {
    this.port = port;
  }

  call<O extends HostOp>(op: O, args: HostOps[O]['args']): Promise<HostOps[O]['result']> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WorkforceError('timeout', `The app did not answer (${op}).`));
      }, TIMEOUTS[op] ?? 15_000);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.port.postMessage({ id, type: 'host', op, args });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /** Feed a `host-result` message from main. */
  resolve(message: HostResponse): void {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new WorkforceError(message.error?.code ?? 'internal', message.error?.message ?? 'The app could not do this.'));
  }

  /** Feed a `power` message from main. */
  emitPower(event: PowerEvent): void {
    for (const listener of this.power) {
      try { listener(event); } catch { /* listeners must not break the bridge */ }
    }
  }

  onPower(listener: (event: PowerEvent) => void): () => void {
    this.power.add(listener);
    return () => { this.power.delete(listener); };
  }

  /** Rejects everything in flight (main went away). */
  close(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new WorkforceError('unavailable', 'The app closed.'));
      this.pending.delete(id);
    }
  }
}

export function createElectronHost(bridge: HostBridgeClient, app: AppInfo): Host {
  const capture: HostCapture = {
    screenshot: (target, format) => bridge.call('screenshot', { target, format }),
    displays: async () => (await bridge.call('displays', {})).displays,
  };
  return {
    kind: 'electron',
    encrypt: async (plain) => (await bridge.call('encrypt', { plain })).cipher,
    decrypt: async (cipher) => (await bridge.call('decrypt', { cipher })).plain,
    notify: async (input) => (await bridge.call('notify', input)).clicked,
    openExternal: async (url) => { await bridge.call('openExternal', { url }); },
    openPath: async (target, reveal) => { await bridge.call('openPath', { path: target, reveal }); },
    capture,
    media: {
      keyframes: (input) => bridge.call('media.analyze', input),
      audio: (input) => bridge.call('media.audio', input), // B-058 G6: any recording/video → 16 kHz mono PCM16
      image: (input) => bridge.call('media.image', input), // B-058 G10: any stored image → JPEG/PNG ≤ maxPx
    },
    sideBrowser: (call) => bridge.call('sideBrowser', call), // B-055: main/side-driver (the person's side browser)
    sideView: { // B-076: main/side-driver/caster.ts (a side tab watched from another PC or a phone)
      cast: (args) => bridge.call('sideCast', args), input: (args) => bridge.call('sideInput', args), nav: (args) => bridge.call('sideNav', args),
    },
    onPower: (listener) => bridge.onPower(listener),
    idleSeconds: async () => (await bridge.call('idleSeconds', {})).seconds,
    keepAwake: (reason) => {
      const id = bridge.call('keepAwake', { reason }).then((result) => result.id).catch(() => undefined);
      return () => { void id.then((value) => { if (value !== undefined) void bridge.call('releaseAwake', { id: value }).catch(() => undefined); }); };
    },
    setBadge: (count) => { void bridge.call('setBadge', { count }).catch(() => undefined); },
    // Main answers first and restarts the utility process afterwards (RuntimeHost).
    restart: async () => { await bridge.call('runtime.restart', {}); },
    // Best effort: an older main without the op keeps its normal boot timeout.
    extendBoot: async (reason) => { await bridge.call('runtime.booting', { reason }).catch(() => undefined); },
    openCompany: (input) => bridge.call('company.open', input), // B-072: main/companies.ts
    app: {
      version: app.version, packaged: app.packaged, resourcesDir: app.resourcesDir, dataDir: app.dataDir, executable: app.executable,
      ...(app.companies ? { companies: app.companies } : {}), // B-072: where the companies on this PC live
      ...(app.start ? { start: app.start } : {}), // B-078: the "+" menu's --start=mine|employee
    },
  };
}
