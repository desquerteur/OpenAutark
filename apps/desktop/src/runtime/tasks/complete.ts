// TaskService.complete (split out of tasks/service.ts): finishing a task with a result. A result needs a summary;
// evidence is welcome, never required. The stored verification is 'reported_by_human' for people and
// 'claimed_by_agent' for agents, whatever the caller claimed (the one verification step may mark it 'verified' later,
// tasks/verification.ts). `notify: false` (B-047 D4, tasks.complete) skips the person's 'done' notification and is
// kept as result.quiet.
// Owns: the done write. Never: trusts a self-declared "verified", completes twice (a done task returns as it is),
// or runs side effects itself (the lifecycle does).

import { WorkforceError } from '../../shared/errors.ts';
import type { TaskResult, TaskView } from '../../shared/model/tasks.ts';
import { isHumanActor } from '../../shared/model/people.ts';
import type { TaskServiceImpl } from './service.ts';

export function completeTask(t: TaskServiceImpl, id: string, result: TaskResult & { notify?: boolean }, by: string): TaskView {
  const before = t.require(id);
  if (before.status === 'done') return t.views([before])[0];
  if (!result?.summary?.trim()) throw new WorkforceError('bad_request', 'Completing a task needs a result summary.');
  const verification: TaskResult['verification'] = isHumanActor(by) ? 'reported_by_human' : 'claimed_by_agent';
  const { verificationNote: _claimedNote, quiet: _claimedQuiet, notify, ...claimed } = result;
  const now = t.s.clock.now();
  const task = t.mutate(id, draft => {
    draft.status = 'done';
    draft.result = { ...claimed, evidence: result.evidence ?? [], verification, ...(notify === false ? { quiet: true as const } : {}) };
    draft.completedAt = now;
    delete draft.waitingOn;
  });
  t.life.completing(task, by, { notify: notify !== false });
  const view = t.emit(task);
  t.life.completed(task, by);
  return view;
}
