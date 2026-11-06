// Verification as one simple step: when an agent completes a task that has a done-condition (doneWhen) and a
// verifier is connected (Subconscious.verify), the result is checked once against it. A real passed check marks it
// 'verified'; a pass without a real check stays claimed with a short note; a rejection keeps the result done, notes
// why ("Verifier disagrees: …") and tells the owner once – the owner decides whether to reopen it. A verdict that
// arrives after a newer completion (or a reopen, removal or the person's finish) is dropped.
// Owns: which completion a running check belongs to and the verification marks. Never: reopens or blocks a task,
// shows unchecked work as verified, or judges the person's own finish.

import { HUMAN_ID } from '../../shared/ids.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import type { Task } from '../../shared/model/tasks.ts';
import type { TaskServiceImpl } from './service.ts';

export class TaskVerification {
  private readonly t: TaskServiceImpl;
  /** Task id → the completion whose verdict is still awaited. */
  private readonly checks = new Map<string, number>();
  private claims = 0;
  constructor(tasks: TaskServiceImpl) { this.t = tasks; }

  /** A completion by an agent with a done-condition: one check starts (a newer completion replaces the claim). */
  start(task: Task, by: string): void {
    this.checks.delete(task.id);
    if (!task.doneWhen || by === HUMAN_ID || !this.t.s.subconscious) return;
    const claim = ++this.claims;
    this.checks.set(task.id, claim);
    void this.verify(task, claim);
  }

  /** The task is gone: a verdict still on its way is dropped. */
  forget(taskId: string): void {
    this.checks.delete(taskId);
  }

  private async verify(task: Task, claim: number): Promise<void> {
    try {
      const verdict = await this.t.s.subconscious!.verify(task, task.result!);
      if (this.checks.get(task.id) !== claim) return; // completed again (or removed) meanwhile
      const current = this.t.repo.get(task.id);
      if (!current || current.status !== 'done' || !current.result || current.result.verification === 'reported_by_human') return;
      const verified = verdict.ok && verdict.checked === true;
      const note = verified ? undefined : verdict.ok ? uncheckedNote(verdict.reason) : `Verifier disagrees: ${excerpt(verdict.reason, 200)}`;
      const updated = this.t.mutate(task.id, (draft) => {
        const result = { ...draft.result!, verification: verified ? 'verified' as const : 'claimed_by_agent' as const };
        if (note) result.verificationNote = note; else delete result.verificationNote;
        draft.result = result;
      });
      this.t.emit(updated);
      if (!verdict.ok && updated.assigneeKind === 'agent' && updated.assigneeId) {
        this.t.s.wakes.wake({
          agentId: updated.assigneeId, reason: 'task', conversationId: updated.conversationId, taskId: updated.id, coalesceKey: `verify:${updated.id}`,
          note: `The verifier thinks the done-condition is not met yet: ${excerpt(verdict.reason, 300)}\nIf it is right, I reopen the task (tasks.update status "working") and finish it; otherwise I leave it done.`,
        });
      }
    } catch (error) {
      this.t.s.log?.warn('task verification failed', { taskId: task.id, error: String(error) });
    } finally {
      if (this.checks.get(task.id) === claim) this.checks.delete(task.id);
    }
  }
}

/** "Not independently checked: …" from the verifier's reason (subconscious/verify.ts). */
export function uncheckedNote(reason: string): string {
  const why = /no verifier|no decision/i.test(reason) ? 'no verifier connected'
    : /unsure/i.test(reason) ? 'the verifier was unsure'
      : /failed/i.test(reason) ? 'the verifier could not run'
        : /no done-condition/i.test(reason) ? 'no done-condition'
          : excerpt(reason.replace(/;?\s*result accepted as claimed\.?$/i, ''), 120);
  return `Not independently checked: ${why}`;
}
