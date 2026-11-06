// Shared fixture for the ownership tests: a manager (Mara) and an agent (Tom) in one chat, a
// task Tom works on, and turn() which plays one finished turn the way the dispatcher would
// (claims Tom's pending wakes first, so each follow-up wake is the one afterTurn planned).
// Owns: this fixture only. Never: real timers, engines or sleeps.

import { agent, harness } from '../chat/harness.ts';
import { OwnershipServiceImpl } from '../../../src/runtime/tasks/ownership.ts';
import type { OwnershipService, RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { CreateTaskInput } from '../../../src/shared/model/tasks.ts';

type Outcome = Parameters<OwnershipService['afterTurn']>[0]['outcome'];

export const S = 1000;
export const M = 60 * S;
export const H = 60 * M;

export function ownershipFixture(options: { manager?: boolean; services?: Partial<RuntimeServices>; task?: Partial<CreateTaskInput> } = {}) {
  const h = harness();
  if (options.manager !== false) h.org.add(agent('ag_mara', 'Mara', { mode: 'manager' }));
  h.org.add(agent('ag_tom', 'Tom', options.manager !== false ? { managerId: 'ag_mara' } : {}));
  const chat = h.chats.create({ title: 'Launch', agentIds: options.manager !== false ? ['ag_tom', 'ag_mara'] : ['ag_tom'], createdBy: 'human' });
  const ownership = options.services ? new OwnershipServiceImpl({ ...h.services, ...options.services } as RuntimeServices) : h.ownership;
  const task = h.tasks.create({ conversationId: chat.id, title: 'Cut the launch video', assigneeId: 'ag_tom', createdBy: 'human', ...options.task });
  h.tasks.claim(task.id, 'ag_tom');

  /** Wakes of an agent for this task that nobody claimed yet. */
  const pending = (agentId = 'ag_tom') => h.wakes.list(agentId).filter(w => w.claimedAt === undefined && w.taskId === task.id);
  /** One finished turn on the task; returns the follow-up wake ownership planned (if any). */
  const turn = (progressed: boolean, outcome: Outcome = progressed ? 'done' : 'failed', note?: string) => {
    const claimed = h.wakes.claim('ag_tom', Number.MAX_SAFE_INTEGER);
    h.wakes.done(claimed.map(w => w.id));
    ownership.afterTurn({ agentId: 'ag_tom', taskId: task.id, runId: 'run_test', progressed, outcome, note });
    return pending()[0];
  };
  const current = () => h.tasks.get(task.id)!;
  const lines = () => h.chats.messages(chat.id).filter(m => m.kind === 'status').map(m => m.body);
  return { ...h, chat, task, ownership, turn, pending, current, lines };
}
