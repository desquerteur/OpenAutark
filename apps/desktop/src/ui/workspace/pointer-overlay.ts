// Named cursors over a live browser view (B-055 Q8), the pure part: which surface a view shows
// (chat:<chatId>/<tab> for a chat's browser, agent:<agentId>/<tab> for an agent's own –
// shared/model/pointers.ts), which pointers it draws (this surface's, not the person's own, not older
// than POINTER_TTL_MS), where a point of the page (CSS px of its viewport) lies on the drawn picture
// (letterboxed: object-fit contain), where a moving pointer is along its path (the motion model's
// steps, shared/model/pointer-motion.ts – the same path the agent's mouse took) and the throttle for the person's own pointer (at most one report per interval, the last
// position wins – one trailing timer, no loop).
// Owns: these helpers. Never: renders, subscribes or sends (PointerLayer.tsx does).

import type { MotionStep } from '../../shared/model/pointer-motion.ts';
import { POINTER_TTL_MS, surfaceKey, type PointerPoint } from '../../shared/model/pointers.ts';
import { drawnArea, type Box } from './browser-input.ts';

/** The pointer surface of a live view's tab (a chat's browser key is chat:<chatId>). */
export function viewSurface(agentId: string, tab: string): string {
  return agentId.startsWith('chat:') ? surfaceKey('chat', agentId.slice(5), tab) : surfaceKey('agent', agentId, tab);
}

/** The pointers a view draws: its surface's, live, not this person's own (`self`: the id the runtime gave it, or a point it just sent). */
export function shownPointers(points: readonly PointerPoint[], surface: string, now: number, self: { id?: string; last?: { x: number; y: number } }): PointerPoint[] {
  return points.filter((point) => {
    if (point.surface !== surface || now - point.at >= POINTER_TTL_MS) return false;
    if (point.actor.kind !== 'person') return true;
    if (self.id) return point.actor.id !== self.id;
    return !(self.last && Math.abs(point.x - self.last.x) < 0.5 && Math.abs(point.y - self.last.y) < 0.5);
  });
}

/** Where page point (x, y) of a `frame`-sized viewport lies inside `view` (px from its top-left), the picture drawn in `picture` (client boxes). */
export function pagePointInView(x: number, y: number, frame: { width: number; height: number }, picture: Box, view: Box): { left: number; top: number } | undefined {
  if (!(frame.width > 0 && frame.height > 0)) return undefined;
  const area = drawnArea(picture, frame);
  if (!(area.width > 0 && area.height > 0)) return undefined;
  return { left: area.left - view.left + (x / frame.width) * area.width, top: area.top - view.top + (y / frame.height) * area.height };
}

/** The position `elapsed` ms into a path (its steps' t from the move's start); the last step after it ended. */
export function positionAt(path: readonly MotionStep[], elapsed: number): { x: number; y: number } | undefined {
  if (!path.length) return undefined;
  if (elapsed <= path[0]!.t) return { x: path[0]!.x, y: path[0]!.y };
  for (let index = 1; index < path.length; index++) {
    const step = path[index]!;
    if (elapsed > step.t) continue;
    const before = path[index - 1]!;
    const span = step.t - before.t;
    const f = span > 0 ? (elapsed - before.t) / span : 1;
    return { x: before.x + (step.x - before.x) * f, y: before.y + (step.y - before.y) * f };
  }
  const last = path[path.length - 1]!;
  return { x: last.x, y: last.y };
}

/** How long a path takes (its last step's t). */
export function pathMs(path: readonly MotionStep[] | undefined): number {
  return path?.length ? Math.max(0, path[path.length - 1]!.t) : 0;
}

export interface ReporterDeps {
  send(point: { x: number; y: number }): void;
  now(): number;
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  /** At most one report per this many ms (default 125: about 8 a second). */
  intervalMs?: number;
}

/** The person's own pointer, throttled: the first move goes at once, later ones at most once per interval (the newest wins). */
export function createPointerReporter(deps: ReporterDeps) {
  const every = deps.intervalMs ?? 125;
  let last = -Infinity;
  let pending: { x: number; y: number } | null = null;
  let timer: unknown = null;
  const flush = () => {
    timer = null;
    if (!pending) return;
    const point = pending;
    pending = null;
    last = deps.now();
    deps.send(point);
  };
  return {
    move(point: { x: number; y: number }): void {
      pending = point;
      const wait = last + every - deps.now();
      if (wait <= 0) { if (timer !== null) { deps.clear(timer); timer = null; } flush(); return; }
      if (timer === null) timer = deps.set(flush, wait);
    },
    stop(): void {
      pending = null;
      if (timer !== null) { deps.clear(timer); timer = null; }
    },
  };
}
