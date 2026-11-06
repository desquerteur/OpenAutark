// The dispatcher's FIFO of agents waiting for a global turn slot (at most `maxConcurrent` turns run
// at once): each agent waits at most once; important work (urgent()) moves to the front. B-057: a split lane never waits
// here – it takes a free slot only while no agent waits (tryAcquire), else it is retried when a lane frees.
// Owns: that order. Never: starts turns, reads wakes or decides when a slot is free (dispatcher.ts).

export class SlotQueue {
  private readonly order: string[] = [];
  private readonly waiting = new Set<string>();

  get size(): number { return this.order.length; }

  has(agentId: string): boolean { return this.waiting.has(agentId); }

  /** Queues an agent at the back (the caller checked it is not waiting yet). */
  push(agentId: string): void {
    this.waiting.add(agentId);
    this.order.push(agentId);
  }

  /** Moves (or puts) an agent to the front. */
  toFront(agentId: string): void {
    const index = this.order.indexOf(agentId);
    if (index >= 0) this.order.splice(index, 1);
    this.order.unshift(agentId);
    this.waiting.add(agentId);
  }

  /** The agent that waited longest, no longer waiting. */
  shift(): string | undefined {
    const next = this.order.shift();
    if (next !== undefined) this.waiting.delete(next);
    return next;
  }

  /** B-057: may a split lane take a slot now, without waiting – one is free (`running` of `max`) and no agent waits for it. */
  tryAcquire(running: number, max: number): boolean {
    return running < max && this.order.length === 0;
  }

  /** Every waiting agent in order; the queue is empty afterwards. */
  drain(): string[] {
    this.waiting.clear();
    return this.order.splice(0);
  }
}
