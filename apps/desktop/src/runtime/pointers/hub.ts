// Named pointers in the runtime (B-055): the last pointer of every person and agent per surface, in
// memory. Browsers and computer use report agent moves; the UI and main report the person's pointer
// (rpc pointers.point); viewers get 'pointers.changed' (at most one per surface every 100 ms);
// agents read pointersLine() in their tool results.
// Owns: the in-memory table, expiry by age and the event throttle. Never: storage, polling loops
// (one trailing timer per surface only while changes are pending) or deciding what agents may do.

import type { Bus } from '../bus.ts';
import { POINTER_PATH_MAX, POINTER_TTL_MS, pointersLine, type PointerPoint } from '../../shared/model/pointers.ts';
import { thinSteps } from '../../shared/model/pointer-motion.ts';

const EMIT_GAP_MS = 100;
const MAX_SURFACES = 200;

export class PointerHub {
  private surfaces = new Map<string, Map<string, PointerPoint>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastEmit = new Map<string, number>();

  private deps: { bus?: Bus; now?: () => number };

  constructor(deps: { bus?: Bus; now?: () => number } = {}) { this.deps = deps; }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  /** Sets an actor's pointer on a surface (replacing its previous one there). */
  point(input: Omit<PointerPoint, 'at'> & { at?: number }): void {
    if (!input.surface || !input.actor?.id) return;
    let table = this.surfaces.get(input.surface);
    if (!table) {
      if (this.surfaces.size >= MAX_SURFACES) this.prune();
      this.surfaces.set(input.surface, (table = new Map()));
    }
    const point: PointerPoint = {
      ...input,
      ...(input.path ? { path: thinSteps(input.path, POINTER_PATH_MAX) } : {}),
      at: input.at ?? this.now(),
    };
    table.set(input.actor.id, point);
    this.changed(input.surface);
  }

  /** Removes an actor's pointer (it left the surface). */
  leave(surface: string, actorId: string): void {
    if (this.surfaces.get(surface)?.delete(actorId)) this.changed(surface);
  }

  /** Live pointers of a surface. */
  on(surface: string): PointerPoint[] {
    const table = this.surfaces.get(surface);
    if (!table) return [];
    const now = this.now();
    return [...table.values()].filter((p) => now - p.at < POINTER_TTL_MS);
  }

  /** Live pointers of every surface whose key starts with `prefix` (e.g. 'chat:c1/'). */
  under(prefix: string): PointerPoint[] {
    const out: PointerPoint[] = [];
    for (const key of this.surfaces.keys()) if (key.startsWith(prefix)) out.push(...this.on(key));
    return out;
  }

  /** The line an agent reads about the others on a surface ('' when nobody else is there). */
  line(surface: string, selfId: string): string {
    return pointersLine(this.on(surface), selfId, this.now());
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Drops expired pointers and empty surfaces; still full: the surface touched longest ago. */
  private prune(): void {
    const now = this.now();
    for (const [key, table] of this.surfaces) {
      for (const [id, p] of table) if (now - p.at >= POINTER_TTL_MS) table.delete(id);
      if (table.size === 0) this.surfaces.delete(key);
    }
    if (this.surfaces.size < MAX_SURFACES) return;
    let oldest: string | undefined;
    let oldestAt = Infinity;
    for (const [key, table] of this.surfaces) {
      const at = Math.max(...[...table.values()].map((p) => p.at));
      if (at < oldestAt) { oldestAt = at; oldest = key; }
    }
    if (oldest) this.surfaces.delete(oldest);
  }

  private changed(surface: string): void {
    const bus = this.deps.bus;
    if (!bus || this.timers.has(surface)) return;
    const wait = Math.max(0, EMIT_GAP_MS - (this.now() - (this.lastEmit.get(surface) ?? 0)));
    const fire = () => {
      this.timers.delete(surface);
      this.lastEmit.set(surface, this.now());
      bus.emit('pointers.changed', { surface, points: this.on(surface) });
    };
    if (wait === 0) fire();
    else this.timers.set(surface, setTimeout(fire, wait));
  }
}
