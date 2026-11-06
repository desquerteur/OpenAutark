// Raw pointer and keyboard steps of computer use (split from service.ts, B-055): clicks, moves,
// drags, wheel steps, typing and keys – each behind the same gate: the person's Stop
// (activity.ts), the pointer lease (lease.ts – another agent holds the mouse and keyboard) and the
// person's priority (presence.ts). B-055 Q9: the pointer travels like the motion style says ('instant' jumps with
// the old one-shot ops; 'glide' – the default – and 'human' read the pointer once and replay the
// whole planned path in one helper 'path' request, motion.ts); the person moving the mouse
// mid-path stops it ('human_active' → the presence refusal). Q8: each move is reported as the
// agent's named pointer on 'screen:local' (screen-pointers.ts); the person's pointer when
// computer use sees them active. Q10: the window a step hit is remembered (window-memory.ts).
// Owns: that gate, the human-priority judgement over host and helper idle times, the request per
// step and what it reports. Never: fights the person for mouse or keyboard, retries an input step,
// types through the clipboard, or plans motion itself (motion.ts / shared/model/pointer-motion.ts).

import type { Host } from '../host.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { DEFAULT_MOTION, isMotionStyle, type MotionStep, type MotionStyle } from '../../shared/model/pointer-motion.ts';
import { POINTER_TTL_MS, type PointerAction } from '../../shared/model/pointers.ts';
import type { Point } from './geometry.ts';
import type { HelperClient } from './helper.ts';
import type { HelperOp } from './protocol.ts';
import type { ComputerActivity } from './activity.ts';
import { HUMAN_IDLE_SECONDS, humanActive, isPresenceRefusal, judgePresence, type Presence } from './presence.ts';
import type { ComputerCaller, PointerLease } from './lease.ts';
import type { WindowMemory } from './window-memory.ts';
import type { ScreenPointers } from './screen-pointers.ts';
import { clickPath, dragPath, movePath, pathTimeout, wheelPath, type Button, type PlannedPath } from './motion.ts';

export interface PointerInputDeps {
  host: Host;
  helper: () => HelperClient;
  activity: ComputerActivity;
  lease: PointerLease;
  windows: WindowMemory;
  pointers: ScreenPointers;
  now: () => number;
  canControl: () => boolean;
  requireControl: (feature: string) => void;
}

export interface StepOptions { caller?: ComputerCaller; motion?: MotionStyle; signal?: AbortSignal }
/** Where a pointer step ended, the window it hit (when the helper says) and the note about another agent there. */
export interface PointerResult extends Point { window?: number; shared?: string }

type StepAnswer = { window?: unknown; title?: unknown } | undefined;

/** The style a call asked for (unknown: refused), else the default. */
export function motionStyle(value: unknown): MotionStyle {
  if (value === undefined) return DEFAULT_MOTION;
  if (!isMotionStyle(value)) throw new WorkforceError('bad_request', "motion must be 'instant', 'glide' or 'human'.");
  return value;
}

export class PointerInput {
  private readonly deps: PointerInputDeps;
  private lastInjectedAt = Number.NEGATIVE_INFINITY;

  constructor(deps: PointerInputDeps) {
    this.deps = deps;
  }

  async click(point: Point, options: StepOptions & { button?: Button; count?: number; targetSize?: number }): Promise<PointerResult> {
    const style = motionStyle(options.motion);
    const button = options.button ?? 'left';
    const count = Math.min(3, Math.max(1, Math.round(options.count ?? 1)));
    if (style === 'instant') return this.oneShot('click', { ...point, button, count }, point, 'click', options);
    return this.travel((from) => clickPath(from, point, style, { button, count, targetSize: options.targetSize }), point, 'click', options);
  }

  async move(point: Point, options: StepOptions): Promise<PointerResult> {
    const style = motionStyle(options.motion);
    if (style === 'instant') return this.oneShot('move', { ...point }, point, 'move', options);
    return this.travel((from) => movePath(from, point, style), point, 'move', options);
  }

  async drag(from: Point, to: Point, options: StepOptions & { button?: Button; durationMs?: number }): Promise<PointerResult> {
    const style = motionStyle(options.motion);
    await this.gate(options);
    const pointer = style === 'instant' ? undefined : await this.cursor();
    const planned = dragPath(pointer, from, to, style, { button: options.button, durationMs: options.durationMs });
    return this.finish(planned, to, 'drag', options);
  }

  async scroll(point: Point | undefined, dx: number, dy: number, options: StepOptions): Promise<PointerResult | undefined> {
    const style = motionStyle(options.motion);
    if (!point || style === 'instant') {
      // Without a point the wheel turns where the pointer is: nothing travels.
      const result = await this.oneShot('scroll', { ...(point ?? {}), dx, dy }, point, 'scroll', options);
      return point ? result : undefined;
    }
    return this.travel((from) => wheelPath(from, point, style, dx, dy), point, 'scroll', options);
  }

  async type(text: string, options: StepOptions): Promise<void> {
    await this.gate(options);
    await this.send('type', { text }, options, text.length * 20 + 10_000);
  }

  async key(vks: number[], repeat: number, options: StepOptions): Promise<void> {
    await this.gate(options);
    await this.send('key', { vks, repeat }, options, undefined);
  }

  /** The gate of a pointer element step (computer.act click/focus): the lease, then the person (quiet-actions.ts swaps on either refusal). */
  async elementGate(caller: ComputerCaller | undefined): Promise<void> {
    this.deps.lease.check(caller);
    await this.guardHuman();
  }

  noteInjected(): void { this.lastInjectedAt = this.deps.now(); }

  /** The helper's "the person moved the mouse mid-path" (nothing was pressed) as the presence refusal; any other error unchanged. */
  humanRefusal(error: unknown): unknown {
    if (!(error instanceof WorkforceError) || error.details?.humanActive !== true) return error;
    if (this.deps.pointers.wired()) void this.cursorOfPerson();
    return humanActive();
  }

  /** An element click arrived at `at` (the helper's answer; else the centre of the observed rectangle). */
  reportClick(caller: ComputerCaller | undefined, at: unknown, rect: [number, number, number, number] | undefined, path: MotionStep[] | undefined): void {
    const point = Array.isArray(at) && at.length === 2 && at.every((n) => typeof n === 'number' && Number.isFinite(n)) ? { x: at[0] as number, y: at[1] as number }
      : rect ? { x: Math.round(rect[0] + rect[2] / 2), y: Math.round(rect[1] + rect[3] / 2) } : undefined;
    if (point) this.deps.pointers.agent(caller, point, 'click', path);
  }

  /**
   * Where the pointer is now (undefined: unknown – the move then jumps). The same answer says
   * whether the person used this PC after our own last input; then their pointer is reported.
   */
  async cursor(): Promise<Point | undefined> {
    let answer: (Presence & { x?: unknown; y?: unknown }) | undefined;
    try { answer = await this.deps.helper().call('cursor', {}, { timeoutMs: 5000 }); } catch { return undefined; }
    if (typeof answer?.x !== 'number' || typeof answer.y !== 'number' || !Number.isFinite(answer.x) || !Number.isFinite(answer.y)) return undefined;
    const point = { x: answer.x, y: answer.y };
    const idle = typeof answer.idleMs === 'number' ? answer.idleMs : undefined;
    const ours = typeof answer.injectedAgoMs === 'number' ? answer.injectedAgoMs : undefined;
    if (idle !== undefined && idle < POINTER_TTL_MS && (ours === undefined || idle + 150 < ours)) this.deps.pointers.person(point);
    return point;
  }

  /**
   * Human priority: recent input that is not ours pauses the agent. The host's idle time also
   * counts our own injected input, so recent input right after our own action is checked with
   * the helper, which knows exactly when it injected last (millisecond tick counts).
   */
  async guardHuman(): Promise<void> {
    try {
      await this.judgeHuman();
    } catch (error) {
      // The agents see where the person is (one cheap read, only where named pointers are wired).
      if (isPresenceRefusal(error) && (error as WorkforceError).code === 'conflict' && this.deps.pointers.wired()) void this.cursorOfPerson();
      throw error;
    }
  }

  // ------------------------------------------------------------------ internals

  private async judgeHuman(): Promise<void> {
    // A headless runtime has no idle source of its own (its host reports "idle"); on Windows the
    // helper reads the real last-input time instead (Linux: X11 XScreenSaver, when there).
    if (this.deps.host.kind !== 'electron' && this.deps.canControl()) return this.checkPresence();
    let idle: number;
    try { idle = await this.deps.host.idleSeconds(); } catch { idle = Number.POSITIVE_INFINITY; }
    if (!(idle < HUMAN_IDLE_SECONDS)) return;
    const sinceOwn = this.deps.now() - this.lastInjectedAt;
    if (sinceOwn > (HUMAN_IDLE_SECONDS + 1) * 1000) throw humanActive();
    if (!this.deps.canControl()) return;
    return this.checkPresence(idle * 1000);
  }

  /** Precise check with the helper's tick counts (presence.ts judgePresence). */
  private async checkPresence(hostIdleMs?: number): Promise<void> {
    judgePresence(await this.deps.helper().call<Presence>('presence', {}, { timeoutMs: 5000 }), hostIdleMs);
  }

  private async cursorOfPerson(): Promise<void> {
    try {
      const at = await this.deps.helper().call<{ x?: unknown; y?: unknown }>('cursor', {}, { timeoutMs: 5000 });
      if (typeof at?.x === 'number' && typeof at.y === 'number') this.deps.pointers.person({ x: at.x, y: at.y });
    } catch { /* the refusal matters, not the position */ }
  }

  private async gate(options: StepOptions): Promise<void> {
    this.deps.requireControl('Mouse and keyboard control');
    options.signal?.throwIfAborted();
    this.deps.activity.guard();
    this.deps.lease.check(options.caller);
    await this.guardHuman();
  }

  /** The old one-request ops for 'instant' (and the wheel where the pointer is). */
  private async oneShot(op: HelperOp, args: Record<string, unknown>, at: Point | undefined, action: PointerAction, options: StepOptions): Promise<PointerResult> {
    await this.gate(options);
    const answer = await this.send<StepAnswer>(op, args, options, undefined);
    return this.after(at, action, options.caller, undefined, answer);
  }

  /** Reads the pointer, plans the path from there, replays it in one request. */
  private async travel(plan: (from: Point | undefined) => PlannedPath, to: Point, action: PointerAction, options: StepOptions): Promise<PointerResult> {
    await this.gate(options);
    return this.finish(plan(await this.cursor()), to, action, options);
  }

  private async finish(planned: PlannedPath, to: Point, action: PointerAction, options: StepOptions): Promise<PointerResult> {
    const answer = await this.send<StepAnswer>('path', { ...planned.args }, options, pathTimeout(planned));
    return this.after(to, action, options.caller, planned.path, answer);
  }

  /** One helper request under the lease; the person moving the mouse mid-path is their priority. */
  private async send<T>(op: HelperOp, args: Record<string, unknown>, options: StepOptions, timeoutMs: number | undefined): Promise<T> {
    const end = this.deps.lease.begin(options.caller);
    try {
      return await this.deps.helper().call<T>(op, args, { signal: options.signal, timeoutMs });
    } catch (error) {
      throw this.humanRefusal(error);
    } finally {
      this.noteInjected();
      end();
    }
  }

  private after(at: Point | undefined, action: PointerAction, caller: ComputerCaller | undefined, path: MotionStep[] | undefined, answer: StepAnswer): PointerResult {
    const window = typeof answer?.window === 'number' && answer.window ? answer.window : undefined;
    if (typeof answer?.title === 'string') this.deps.windows.title(window, answer.title);
    if (at) this.deps.pointers.agent(caller, at, action, path);
    this.deps.lease.noteWindow(caller, window);
    const shared = this.deps.windows.use(caller, window);
    return { x: at?.x ?? 0, y: at?.y ?? 0, ...(window ? { window } : {}), ...(shared ? { shared } : {}) };
  }
}
