// Browser glue of the ```app CPU watchdog (app-watchdog.ts) for one live frame: the shared
// long-task observer (attribution by the iframe's id), heartbeat pings over postMessage with
// real timers, and pausing while the page is hidden.
// Owns: wiring one frame to the watchdog. Never: decides what "too busy" is (the watchdog
// does), reads frame content, or keeps anything after `dispose`.

import { APP_METHODS } from '../../shared/blocks/app-bridge.ts';
import { CpuWatchdog, LongTaskHub } from './app-watchdog.ts';
import type { LongTaskEntry, LongTaskSource, TripReason, WatchdogDeps } from './app-watchdog.ts';

interface Attribution { containerId?: string }

/** PerformanceObserver('longtask'), or null where the browser does not report long tasks. */
const browserLongTasks: LongTaskSource = (onEntries) => {
  if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) return null;
  const observer = new PerformanceObserver((list) => {
    const entries: LongTaskEntry[] = list.getEntries().map((entry) => ({
      startTime: entry.startTime,
      duration: entry.duration,
      containers: ((entry as PerformanceEntry & { attribution?: Attribution[] }).attribution ?? [])
        .map((item) => item.containerId ?? '').filter(Boolean),
    }));
    onEntries(entries);
  });
  try { observer.observe({ type: 'longtask', buffered: false }); } catch { return null; }
  return () => observer.disconnect();
};

const longTasks = new LongTaskHub(browserLongTasks);

const realTimers = {
  now: () => Date.now(),
  set: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface FrameGuard {
  /** Any message from the frame. */
  alive(): void;
  /** The app finished its handshake: the heartbeat starts. */
  initialized(): void;
  dispose(): void;
}

/** id attribute for a frame's <iframe> (long tasks are attributed by it). */
export function frameElementId(blockKey: string, mode: string): string {
  return `wf-app-${blockKey.replace(/[^A-Za-z0-9_-]/g, '_')}-${mode}`;
}

/** `limits`: other numbers than WATCHDOG's (a plugin frame in its own process: a longer heartbeatMs). */
export function guardFrame(options: { elementId: string; post: (message: Record<string, unknown>) => void; onTrip: (reason: TripReason) => void; limits?: WatchdogDeps['limits'] }): FrameGuard {
  const watchdog = new CpuWatchdog({
    ping: (id) => options.post({ id, method: APP_METHODS.ping }),
    onTrip: options.onTrip,
    timers: realTimers,
    limits: options.limits,
  });
  const offLongTasks = longTasks.watch(options.elementId, (start, duration) => watchdog.longTask(start, duration));
  const onVisibility = () => { if (document.visibilityState === 'hidden') watchdog.pause(); else watchdog.resume(); };
  document.addEventListener('visibilitychange', onVisibility);
  return {
    alive: () => watchdog.alive(),
    initialized: () => {
      watchdog.start();
      if (document.visibilityState === 'hidden') watchdog.pause();
    },
    dispose: () => {
      watchdog.stop();
      offLongTasks();
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
