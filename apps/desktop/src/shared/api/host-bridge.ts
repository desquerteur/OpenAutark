// Host bridge: the message protocol between Electron main and the runtime utility process
// (process.parentPort on the runtime side, UtilityProcess.postMessage on the main side).
// Owns: message shapes, the op list with argument/result types, and tolerant parsers.
// Never: carries RPC traffic for clients – renderers and main talk JSON-RPC (protocol.ts) over
// MessagePorts that main transfers with a `connect` message. Never carries secrets in logs.
//
// Lifecycle:
//   main forks runtime ──► {type:'init', token, app}            (token never goes into env)
//   runtime booted     ──► {type:'ready', token, protocol}       (main verifies the token)
//   runtime asks host  ──► {id, type:'host', op, args}           ◄── {id, type:'host-result', ok, result|error}
//   main pushes        ──► {type:'power'|'event'|'connect'|'shutdown'|'pointer'|'side-view', …}
// A `connect` message transfers exactly one MessagePort (ports[0]); the runtime serves JSON-RPC
// on it with owner scope (desktop window or main itself).

import type { WorkforceErrorData } from '../errors.ts';
import type { EventMap, EventName } from './events.ts';
import type { SideBrowserCall, SideBrowserResult } from '../model/side-browser.ts'; // B-055
import type { PointerPoint } from '../model/pointers.ts'; // B-055 F1
import type { SideCastUpdate, SideCommand, SidePage } from '../model/side-view.ts'; // B-076
import type { CompanyStart } from '../model/companies.ts'; // B-078

export const HOST_BRIDGE_PROTOCOL = 1;

/** powerMonitor's states, and B-044 'online': the app window's network came back (its navigator 'online' event, via main). */
export type PowerEvent = 'resume' | 'suspend' | 'lock' | 'unlock' | 'online';

/** Ops the runtime may ask the host for, with argument and result types. */
export interface HostOps {
  encrypt: { args: { plain: string }; result: { cipher: Uint8Array } };
  decrypt: { args: { cipher: Uint8Array }; result: { plain: string } };
  /** Native notification; result.clicked is true when the user clicked it (false on close/timeout). */
  notify: { args: { title: string; body: string; silent?: boolean; tag?: string; conversationId?: string; taskId?: string }; result: { clicked: boolean } };
  openExternal: { args: { url: string }; result: { ok: true } };
  openPath: { args: { path: string; reveal?: boolean }; result: { ok: true } };
  screenshot: {
    args: { target: { display?: number; window?: 'app' }; format?: 'png' | 'jpeg' };
    result: { data: Uint8Array; width: number; height: number; mime: string };
  };
  displays: { args: Record<string, never>; result: { displays: Array<{ index: number; width: number; height: number; scale: number; primary: boolean }> } };
  idleSeconds: { args: Record<string, never>; result: { seconds: number } };
  /** Starts a power-save blocker; release it with `releaseAwake`. */
  keepAwake: { args: { reason: string }; result: { id: number } };
  releaseAwake: { args: { id: number }; result: { ok: true } };
  setBadge: { args: { count: number }; result: { ok: true } };
  /** MM7: main answers, then stops this runtime and starts it again at once (e.g. to apply a staged restore). Answered by RuntimeHost. */
  'runtime.restart': { args: Record<string, never>; result: { ok: true } };
  /** MM7: before `ready` – the runtime applies a staged restore (copies the data in), so main waits longer for `ready`. Answered by RuntimeHost. */
  'runtime.booting': { args: { reason: 'restore' }; result: { ok: true } };
  /** MM4: keyframes of a stored video (blob id) from main's hidden media analyzer window (main/media-analyzer.ts). */
  'media.analyze': { args: { fileId: string; mime?: string; frames?: number }; result: Keyframes };
  /** B-055: an agent works in the person's side browser (shared/model/side-browser.ts); answered by main/side-driver. Missing in main = 'unavailable'. */
  sideBrowser: { args: SideBrowserCall; result: SideBrowserResult };
  /** B-058 G6: a stored recording or video (blob id) decoded by main's media analyzer to 16 kHz mono PCM, from `startMs` for at most `maxMs` (AUDIO_DECODE_LIMITS). */
  'media.audio': { args: { fileId: string; mime?: string; startMs?: number; maxMs?: number }; result: DecodedAudio };
  /** B-058 G10: a stored image (blob id) normalized by main's media analyzer – JPEG/PNG, longest edge ≤ maxPx, optionally a region (IMAGE_LIMITS). */
  'media.image': { args: { fileId: string; mime?: string; maxPx?: number; region?: ImageRegion }; result: NormalizedImage };
  /** B-072: opens a company on this PC (main/companies.ts; create: a new folder first); this window goes to the tray. */
  'company.open': { args: { id?: string | null; create?: boolean; start?: CompanyStart }; result: { ok: true; id: string | null } };
  /**
   * B-076: someone watches side tab `tab` from another PC or a phone (main/side-driver/caster.ts): `on` wakes the page,
   * starts its screencast or renews it (it ends a minute after the last renewal), off ends it now. Frames reach the
   * runtime as `side-view` messages.
   */
  sideCast: { args: { tab: string; on: boolean }; result: { ok: true; page?: SidePage } };
  /** B-076: the watcher's input in that tab – Input.dispatchMouseEvent, dispatchKeyEvent and insertText only; it counts as the person's. */
  sideInput: { args: { tab: string; commands: SideCommand[] }; result: { ok: true } };
  /** B-076: a new http(s) address, back, forward or reload in that tab, or the answer to its open dialog. */
  sideNav: { args: { tab: string; url?: string; action?: 'back' | 'forward' | 'reload'; dialog?: 'accept' | 'dismiss' }; result: { ok: true } };
}

/** MM4: limits of `media.analyze` – frames per call, longest image edge, one job's time, jobs waiting behind it. */
export const KEYFRAME_LIMITS = { frames: 12, defaultFrames: 6, edge: 768, jobMs: 30_000, waiting: 3 } as const;

/** MM4: one keyframe – a JPEG of the video at `atMs`; `scene` = chosen for a scene change (else to cover the time). */
export interface Keyframe { atMs: number; scene: boolean; data: Uint8Array; width: number; height: number; mime: 'image/jpeg' }

/** MM4: the frames of one video in time order, with the video's duration and size. */
export interface Keyframes { durationMs: number; width: number; height: number; frames: Keyframe[] }

/**
 * B-058 G6: limits of `media.audio` – output rate, the longest span decoded per call (longer: partial), one job's
 * time, decodes waiting behind the analyzer's running job (more: conflict; T2), the most bytes of a file read whole.
 */
export const AUDIO_DECODE_LIMITS = { rate: 16_000, maxMs: 20 * 60_000, jobMs: 120_000, waiting: 3, inputBytes: 512 * 1024 * 1024 } as const;

/**
 * B-058 G6: decoded sound of one stored file – `pcm` holds 16-bit signed little-endian mono samples at 16 kHz
 * (the bytes travel like Keyframe.data, a Uint8Array); `startMs` where they begin, `durationMs` the file's whole
 * length, `partial` = the sound goes on after the decoded span.
 */
export interface DecodedAudio { sampleRate: 16_000; pcm: Uint8Array; durationMs: number; startMs: number; partial: boolean }

/**
 * B-058 G10: limits of `media.image` – the longest edge sent to a model (Anthropic's 1568 px sweet spot), the most
 * bytes of one result, one job's time and images waiting behind the analyzer's running job (more: conflict; T2).
 */
export const IMAGE_LIMITS = { maxPx: 1568, maxBytes: 3_750_000, jobMs: 20_000, waiting: 8 } as const; // maxBytes: Anthropic's 5 MB as base64 (B-058 i1), so a big PNG copy becomes a JPEG in the page

/** B-058 G10: a part of an image as fractions 0..1 of its width and height (x, y = top left). */
export interface ImageRegion { x: number; y: number; w: number; h: number }

/** B-058 G10: a normalized image – JPEG (photos) or PNG (alpha, line art), at most IMAGE_LIMITS.maxPx on its longest edge. */
export interface NormalizedImage { data: Uint8Array; mime: 'image/jpeg' | 'image/png'; width: number; height: number }

export type HostOp = keyof HostOps;

export const HOST_OPS: readonly HostOp[] = [
  'encrypt', 'decrypt', 'notify', 'openExternal', 'openPath', 'screenshot', 'displays', 'idleSeconds',
  'keepAwake', 'releaseAwake', 'setBadge',
  'runtime.restart', 'runtime.booting', // MM7
  'media.analyze', // MM4
  'sideBrowser', // B-055
  'media.audio', 'media.image', // B-058
  'company.open', // B-072
  'sideCast', 'sideInput', 'sideNav', // B-076
];

export interface AppInfo {
  version: string;
  packaged: boolean;
  resourcesDir: string;
  dataDir: string;
  executable: string;
  /** B-072: the first company's data folder and the folder of the others (<dir>/<id>); missing in a test profile. */
  companies?: { first: string; dir: string };
  /** B-078: how this company's start was asked for (main/companies.ts startFlag of `--start=`); missing for a plain start. */
  start?: CompanyStart;
}

// ------------------------------------------------------------------ runtime → main

export interface HostRequest<O extends HostOp = HostOp> {
  id: number;
  type: 'host';
  op: O;
  args: HostOps[O]['args'];
}

export interface RuntimeReady {
  type: 'ready';
  token: string;
  protocol: number;
}

export type RuntimeToMain = HostRequest | RuntimeReady;

// ------------------------------------------------------------------ main → runtime

export interface InitMessage {
  type: 'init';
  token: string; // launch token: proves to main that the runtime is ours; also the local CLI token
  protocol: number;
  app: AppInfo;
}

export interface HostResponse {
  id: number;
  type: 'host-result';
  ok: boolean;
  result?: unknown;
  error?: WorkforceErrorData;
}

export interface PowerMessage { type: 'power'; event: PowerEvent }
/** Transfers ports[0] to the runtime; `client` tells it who is on the other end (both owner scope, main's marked `main`). */
export interface ConnectMessage { type: 'connect'; client: 'desktop' | 'main' }
/** An event produced in main (e.g. update.state) for the runtime to publish on its bus. */
export interface EventMessage<E extends EventName = EventName> { type: 'event'; event: E; data: EventMap[E] }
/** Asks the runtime to drain (checkpoint runs, flush WAL, stop children) and exit. */
export interface ShutdownMessage { type: 'shutdown'; reason: 'quit' | 'update' }
/**
 * B-055 F1: a pointer main saw in the person's side browser (main/side-driver; surface side:<tabId>) for the
 * runtime's pointer hub: the person's own (actor kind 'person', id 'owner', named from the profile) or an agent's
 * move there (with its path). Best effort: sent only while the runtime is up, never replayed after a restart.
 */
export interface PointerMessage { type: 'pointer'; point: Omit<PointerPoint, 'at'> }

/**
 * B-076: a frame or the page of a side tab someone watches (main/side-driver/caster.ts, at most one frame per 500 ms)
 * for the runtime's side views. Like `pointer`: sent only while the runtime is up, never queued or replayed.
 */
export interface SideViewMessage { type: 'side-view'; update: SideCastUpdate }

export type MainToRuntime = InitMessage | HostResponse | PowerMessage | ConnectMessage | EventMessage | ShutdownMessage | PointerMessage | SideViewMessage;

// ------------------------------------------------------------------ parsers (tolerant, never throw)

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isHostOp(value: unknown): value is HostOp {
  return typeof value === 'string' && (HOST_OPS as readonly string[]).includes(value);
}

/** Parses a message received by main from the runtime; null when malformed or unknown. */
export function parseRuntimeMessage(value: unknown): RuntimeToMain | null {
  if (!isObject(value)) return null;
  if (value.type === 'ready') {
    if (typeof value.token !== 'string' || typeof value.protocol !== 'number') return null;
    return { type: 'ready', token: value.token, protocol: value.protocol };
  }
  if (value.type === 'host') {
    if (!Number.isSafeInteger(value.id) || !isHostOp(value.op)) return null;
    const args = value.args === undefined ? {} : value.args;
    if (!isObject(args)) return null;
    return { id: value.id as number, type: 'host', op: value.op, args: args as HostOps[HostOp]['args'] };
  }
  return null;
}

const POWER_EVENTS: readonly string[] = ['resume', 'suspend', 'lock', 'unlock', 'online'];

/** Parses a message received by the runtime from main; null when malformed or unknown. */
export function parseMainMessage(value: unknown): MainToRuntime | null {
  if (!isObject(value)) return null;
  switch (value.type) {
    case 'init':
      if (typeof value.token !== 'string' || typeof value.protocol !== 'number' || !isObject(value.app)) return null;
      return value as unknown as InitMessage;
    case 'host-result':
      if (!Number.isSafeInteger(value.id) || typeof value.ok !== 'boolean') return null;
      return value as unknown as HostResponse;
    case 'power':
      return typeof value.event === 'string' && POWER_EVENTS.includes(value.event) ? { type: 'power', event: value.event as PowerEvent } : null;
    case 'connect':
      return value.client === 'desktop' || value.client === 'main' ? { type: 'connect', client: value.client } : null;
    case 'event':
      return typeof value.event === 'string' ? value as unknown as EventMessage : null;
    case 'shutdown':
      return value.reason === 'quit' || value.reason === 'update' ? { type: 'shutdown', reason: value.reason } : null;
    case 'pointer': { // B-055 F1
      const point = value.point as Record<string, unknown> | undefined;
      const actor = isObject(point) ? point.actor as Record<string, unknown> | undefined : undefined;
      if (!isObject(point) || typeof point.surface !== 'string' || !isObject(actor) || (actor.kind !== 'person' && actor.kind !== 'agent')
        || typeof actor.id !== 'string' || typeof actor.name !== 'string' || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
      return { type: 'pointer', point: point as unknown as PointerMessage['point'] };
    }
    case 'side-view': { // B-076
      const update = value.update as Record<string, unknown> | undefined;
      if (!isObject(update) || typeof update.tab !== 'string' || !isObject(update.page) || typeof update.live !== 'boolean') return null;
      return { type: 'side-view', update: update as unknown as SideCastUpdate };
    }
    default:
      return null;
  }
}
