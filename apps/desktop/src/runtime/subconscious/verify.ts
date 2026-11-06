// Clean-context verification of a task result against its done-condition: only the task
// title, the done-condition, the mode's verifier rubric and the result (summary, extras,
// evidence labels) go to the decision model – never the agent's conversation. I02: a task with its own branch adds
// one line of its last recorded change stat (git/records.ts; no git runs here). B-044: a task with steps adds
// 'Steps: x/y done; open: …' (tasks/open-steps.ts), so the verdict covers the steps too.
// B-047 D11: first the deterministic evidence checks (services.evidence, subconscious/verify-evidence.ts – a named
// file exists and is not empty, a named link answers): one that confidently fails rejects the result with what
// failed (checked=true), whatever else holds; the lines of the checks that ran go into the predicate's context as
// facts checked by the runtime. A result without a done-condition is never "checked": it stays unverified
// (checked=false, reason 'no done-condition'), also when its evidence held.
// Owns: the verdict rules. A result without summary and evidence fails; no done-condition or
// no decision model passes with a reason that says so and checked=false; an unsure "no" does
// not reopen work.
// Never: trusts the agent's own claim of verification or runs tools.

import type { RuntimeServices } from '../contracts.ts';
import type { EvidenceCheck } from '../contracts/evidence.ts';
import type { Task, TaskResult } from '../../shared/model/tasks.ts';
import { excerpt } from '../../shared/text/chat-names.ts';

const MIN_CONFIDENCE = 0.5;

function rubric(services: RuntimeServices, task: Task): string | undefined {
  if (!task.mode) return undefined;
  try { return services.modes.get(task.mode).verifier; } catch { return undefined; }
}

/** 'Steps: 3/5 done; open: "…", "…"' over the steps that were not cancelled; undefined without steps. */
export function stepsLine(steps: readonly Pick<Task, 'title' | 'status'>[]): string | undefined {
  const counted = steps.filter((step) => step.status !== 'cancelled');
  if (!counted.length) return undefined;
  const open = counted.filter((step) => step.status !== 'done').map((step) => `"${excerpt(step.title, 80)}"`);
  const shown = open.length > 5 ? `${open.slice(0, 5).join(', ')} +${open.length - 5} more` : open.join(', ');
  return `Steps: ${counted.length - open.length}/${counted.length} done${open.length ? `; open: ${shown}` : ''}`;
}

/** B-044: the task's step count for the verifier (undefined without steps or tasks). */
function stepsOf(services: Pick<RuntimeServices, 'tasks'>, task: Pick<Task, 'id'>): string | undefined {
  try { return stepsLine(services.tasks.get(task.id)?.steps ?? []); } catch { return undefined; }
}

/** B-047 D11: the deterministic checks of the result's evidence ([] without a checker or when it fails). */
async function evidenceChecks(services: RuntimeServices, result: TaskResult): Promise<EvidenceCheck[]> {
  const checker = services.evidence;
  if (!checker || !(result.evidence ?? []).length) return [];
  try {
    let workspace: string | undefined;
    try { workspace = services.paths.workspace; } catch { workspace = undefined; }
    return await checker.check(result.evidence, { workspace });
  } catch (error) {
    services.log.debug('evidence checks failed; the predicate alone judges', { error: String(error) });
    return [];
  }
}

/** "Checked by the runtime:" lines for the predicate's context (undefined when nothing was checked). */
export function checkedLines(checks: readonly EvidenceCheck[]): string | undefined {
  return checks.length ? `Checked by the runtime (facts):\n${checks.map((check) => `- ${check.line}`).join('\n')}` : undefined;
}

export function resultContext(task: Task, result: TaskResult, verifier?: string, branch?: string, steps?: string, checked?: string): string {
  const lines = [`Task: ${task.title}`, `Done when: ${task.doneWhen ?? '(not set)'}`];
  if (verifier) lines.push(`Quality rubric: ${verifier}`);
  lines.push(`Result: ${excerpt(result.summary ?? '', 1500)}`);
  if (result.alsoHandled?.length) lines.push(`Also handled: ${result.alsoHandled.map((item) => excerpt(item, 160)).join('; ')}`);
  const evidence = result.evidence ?? [];
  lines.push(evidence.length ? `Evidence:\n${evidence.slice(0, 20).map((item) => `- ${item.kind}: ${excerpt(item.label, 200)}${item.ref ? ` (${excerpt(item.ref, 160)})` : ''}`).join('\n')}` : 'Evidence: none');
  if (steps) lines.push(steps);
  if (branch) lines.push(branch);
  if (checked) lines.push(checked);
  return lines.join('\n');
}

export async function verifyResult(services: RuntimeServices, task: Task, result: TaskResult): Promise<{ ok: boolean; reason: string; checked: boolean }> {
  const summary = result?.summary?.trim() ?? '';
  const evidence = result?.evidence ?? [];
  if (!summary && !evidence.length) return { ok: false, reason: 'The result has no summary and no evidence.', checked: true };
  // B-047 D11: deterministic checks first – evidence that confidently does not hold rejects the result.
  const checks = await evidenceChecks(services, result);
  const failed = checks.filter((check) => check.ok === false);
  if (failed.length) {
    return { ok: false, reason: `The evidence does not hold: ${failed.map((check) => check.line).join('; ')}. Fix it or give evidence that exists.`, checked: true };
  }
  if (!task.doneWhen?.trim()) return { ok: true, reason: 'no done-condition', checked: false }; // unverified, never "checked"
  if (!services.decisions?.available()) return { ok: true, reason: 'no verifier available; result accepted as claimed', checked: false };
  try {
    const verdict = await services.decisions.decide({
      type: 'predicate', purpose: 'verify',
      question: `Does this result satisfy: ${task.doneWhen.trim()}?`,
      context: resultContext(task, result, rubric(services, task), undefined, stepsOf(services, task), checkedLines(checks)),
    });
    if (verdict.value === true && verdict.confidence >= MIN_CONFIDENCE) return { ok: true, reason: `done-condition met (checked by ${verdict.by})`, checked: true };
    if (verdict.value === false && verdict.confidence >= MIN_CONFIDENCE) {
      return { ok: false, reason: `The result does not show that this is met: ${excerpt(task.doneWhen, 200)}. Add the missing work or evidence.`, checked: true };
    }
    return { ok: true, reason: 'verifier unsure; result accepted as claimed', checked: false };
  } catch (error) {
    services.log.debug('verification failed; result accepted as claimed', { taskId: task.id, error: String(error) });
    return { ok: true, reason: 'verifier failed; result accepted as claimed', checked: false };
  }
}
