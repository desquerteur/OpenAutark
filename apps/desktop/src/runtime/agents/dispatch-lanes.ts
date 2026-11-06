// B-057 S12 – the dispatcher's split lanes. A split of an agent (shared/model/splits.ts) runs its turn on its own lane
// `<agentId>#<splitId>` beside the agent's main lane, which stays free for the agent's own work (dispatch-runs.ts keeps
// every lane in its running map). A split lane takes a global slot only when one is free right now and no agent waits
// for one (dispatch-slots.ts tryAcquire), while all split lanes together hold fewer than splitSlots(maxConcurrent) –
// one slot always stays for main lanes (the agents' replies to the person) – and at most SPLIT_LIMITS.runningPerAgent
// run per agent; otherwise it is 'busy' and the split service tries again when a lane or slot frees (onLaneFree – the
// dispatcher fires it after every lane's end, when turns may start again and when a paused agent is resumed). A split
// whose lane still holds its ended turn (a retry asked for from inside that turn's finish) is 'busy' too. 'refused':
// under the person's emergency stop, for an archived or missing agent, or a split the split service does not hand out.
// The lane builds the turn's request from the split service – turnFor (its SplitTurn), inputFor (its brief and its
// dependencies' results as notes), the group's origin – with reason 'split', a new run id and neither chat nor task;
// the same TurnExecutor runs it. The person's Stop of an agent in a chat ends its splits there through the split
// service (rpc/handlers/chats.ts messages.stop, S13) – dispatcher.interrupt never does (a task's stop is no such Stop).
// Owns: starting, listing and stopping split lanes and the lane-free listeners. Never: decides which split is ready or
// how it ended (runtime/splits/service.ts), touches the main lane's wakes, urgent picks or steering, or queues a split
// lane in the slot FIFO.

import type { RuntimeServices, SplitLane } from '../contracts.ts';
import type { Origin } from '../../shared/model/origin.ts';
import { newId } from '../../shared/ids.ts';
import { SPLIT_LIMITS } from '../../shared/model/splits.ts';
import { abortTurn, runEntry, type RunningTurns } from './dispatch-runs.ts';

export type LaneStart = 'started' | 'busy' | 'refused';

/** The lane of a split. */
export function laneKey(agentId: string, splitId: string): string {
  return `${agentId}#${splitId}`;
}

/** How many global slots split lanes may hold together: all but one (that one stays for main lanes); one at a cap of one. */
export function splitSlots(maxConcurrent: number): number {
  return Math.max(1, maxConcurrent - 1);
}

/** What the lanes need from the dispatcher. */
export interface LaneHost {
  services: () => RuntimeServices;
  runs: RunningTurns;
  /** May turns start now: 'refused' under the emergency stop, 'busy' while not started or paused (an update restart). */
  gate(): 'ok' | 'busy' | 'refused';
  /** A global slot is free now for a split lane: no agent waits for one and the split lanes hold fewer than splitSlots(). */
  slotFree(): boolean;
  /** A paused agent's split waits: the dispatcher fires the lane-free listeners when the agent is resumed. */
  hold(agentId: string): void;
}

export class SplitLanes {
  private readonly host: LaneHost;
  private readonly listeners = new Set<() => void>();

  constructor(host: LaneHost) {
    this.host = host;
  }

  /** Starts a split's turn on its lane now, or says why not ('busy': try again on a lane-free event). */
  start(input: { agentId: string; splitId: string }): LaneStart {
    const services = this.host.services();
    try {
      const gate = this.host.gate();
      if (gate !== 'ok') return gate;
      // Its lane still holds the turn that just ended (the split service re-queues a retry from inside that turn's
      // finish, before the lane is freed): 'busy' – the lane's end fires the listeners and the split starts then.
      if (this.host.runs.lane(laneKey(input.agentId, input.splitId))) return 'busy';
      const agent = services.org.get(input.agentId);
      if (!agent || agent.archivedAt) return 'refused';
      // Paused by the person or a manager (the main lane's order): waits for the un-pause.
      if (agent.status === 'paused') {
        this.host.hold(agent.id);
        return 'busy';
      }
      if (this.host.runs.lanes(agent.id).length >= SPLIT_LIMITS.runningPerAgent || !this.host.slotFree()) return 'busy';
      const split = services.splits?.turnFor(input.splitId);
      if (!split || split.splitId !== input.splitId) return 'refused';
      const now = services.clock.now();
      const runId = newId('run', now);
      const notes = services.splits?.inputFor(input.splitId) ?? [];
      const origin = groupOrigin(services, input.splitId);
      const entry = runEntry({
        runId, agentId: agent.id, lane: laneKey(agent.id, split.splitId), reason: 'split', split,
        wakeIds: [], attempts: 0, startedAt: now, ...(origin ? { origin } : {}),
      });
      this.host.runs.launch(services, entry, { runId: entry.runId, agentId: agent.id, reason: 'split', split, notes, ...(origin ? { origin } : {}) });
      return 'started';
    } catch (error) {
      services.log.warn('split lane could not start', { ...input, error: String(error) });
      return 'busy';
    }
  }

  /** Running split lanes (of one agent). */
  list(agentId?: string): SplitLane[] {
    return this.host.runs.lanes(agentId).map((entry) => ({ agentId: entry.agentId, splitId: entry.split!.splitId, runId: entry.runId }));
  }

  /** Aborts a running split lane: the person's Stop ('human' – the split ends stopped) or a cut ('shutdown'). */
  stop(splitId: string, why: 'human' | 'shutdown'): boolean {
    const entry = this.host.runs.lanes().find((item) => item.split?.splitId === splitId);
    if (!entry) return false;
    if (why === 'human') abortTurn(entry, 'The split was stopped.', 'human');
    else abortTurn(entry, 'The split was cut off.', 'shutdown', 'release');
    return true;
  }

  /** `listener` runs whenever a lane or slot frees or turns may start again; returns its removal. */
  onFree(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** A lane or slot freed (or turns may start again): the split service starts what is ready. Nothing while turns may not start. */
  fire(): void {
    if (!this.listeners.size || this.host.gate() !== 'ok') return;
    const services = this.host.services();
    for (const listener of [...this.listeners]) {
      try { listener(); } catch (error) {
        services.log.warn('lane-free listener failed', { error: String(error) });
      }
    }
  }
}

/** The origin of a split's group (what started its parent's turn), shown in its activity row and run. */
function groupOrigin(services: RuntimeServices, splitId: string): Origin | undefined {
  try { return services.splits?.get(splitId)?.group.origin; } catch { return undefined; }
}
