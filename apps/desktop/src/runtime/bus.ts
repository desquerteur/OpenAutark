// In-process typed event bus. Runtime modules publish domain events here; the RPC server
// forwards them to subscribed clients by topic; other modules react (delivery, presence …).
// Owns: synchronous fan-out with error isolation. Never: persistence or cross-process delivery.

import type { EventMap, EventName } from '../shared/api/events.ts';

type Listener<E extends EventName> = (data: EventMap[E]) => void;
type AnyListener = (event: EventName, data: unknown) => void;

export class Bus {
  private listeners = new Map<EventName, Set<Listener<EventName>>>();
  private any = new Set<AnyListener>();
  private onError: (error: unknown, event: EventName) => void;

  constructor(onError: (error: unknown, event: EventName) => void = () => {}) {
    this.onError = onError;
  }

  on<E extends EventName>(event: E, listener: Listener<E>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener as Listener<EventName>);
    return () => set!.delete(listener as Listener<EventName>);
  }

  /** Receives every event (used by the RPC server). */
  onAny(listener: AnyListener): () => void {
    this.any.add(listener);
    return () => this.any.delete(listener);
  }

  emit<E extends EventName>(event: E, data: EventMap[E]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try { listener(data); } catch (error) { this.onError(error, event); }
    }
    for (const listener of this.any) {
      try { listener(event, data); } catch (error) { this.onError(error, event); }
    }
  }
}
