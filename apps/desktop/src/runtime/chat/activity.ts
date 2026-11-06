// Live "who is working" state derived from the bus event `agent.activity` (published by the
// dispatcher). Used by task views (running spinner); a chat's working state comes from its rows (B-075, chat/summary.ts).
// Owns: the latest activity snapshot and change detection per conversation/task.
// Never: invents activity from model text – only runtime state counts ("activity truth").

import type { Bus } from '../bus.ts';
import type { AgentActivity } from '../../shared/model/runs.ts';

export class ActivityTracker {
  private active: AgentActivity[] = [];
  private readonly unsubscribe: () => void;

  /** `onChange` receives the conversation and task ids whose working state changed. */
  constructor(bus: Bus, onChange: (change: { conversations: string[]; tasks: string[] }) => void = () => {}) {
    this.unsubscribe = bus.on('agent.activity', ({ active }) => {
      const before = this.active;
      this.active = active;
      onChange({
        conversations: diff(before, active, item => item.conversationId),
        tasks: diff(before, active, item => item.taskId),
      });
    });
  }

  /** Agent ids currently running a turn in this conversation. */
  working(conversationId: string): string[] {
    return [...new Set(this.active.filter(item => item.conversationId === conversationId).map(item => item.agentId))];
  }

  running(taskId: string): boolean {
    return this.active.some(item => item.taskId === taskId);
  }

  isActive(agentId: string, conversationId?: string): boolean {
    return this.active.some(item => item.agentId === agentId && (!conversationId || item.conversationId === conversationId));
  }

  dispose(): void {
    this.unsubscribe();
  }
}

/** Keys whose set of (agent, key) pairs changed between two snapshots. */
function diff(before: AgentActivity[], after: AgentActivity[], key: (item: AgentActivity) => string | undefined): string[] {
  const sig = (list: AgentActivity[]) => {
    const map = new Map<string, string>();
    for (const item of list) {
      const k = key(item);
      if (!k) continue;
      map.set(k, [...(map.get(k)?.split(',') ?? []), item.agentId].sort().join(','));
    }
    return map;
  };
  const a = sig(before);
  const b = sig(after);
  const changed = new Set<string>();
  for (const [k, v] of a) if (b.get(k) !== v) changed.add(k);
  for (const [k, v] of b) if (a.get(k) !== v) changed.add(k);
  return [...changed];
}
