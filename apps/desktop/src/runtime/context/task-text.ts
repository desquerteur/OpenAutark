// The current task as the agent sees it in its volatile prompt: title, state, goal ancestry,
// done-condition, notes, checklist steps, plan, what was tried (ledger),
// facts, waiting state and the result so far; I02: the task's own worktree folder and branch (git/records.ts).
// Owns: that rendering and its caps; goal ancestry walk (bounded, cycle-safe).
// Never: claims verification the task row does not record.

import type { RuntimeServices } from '../contracts.ts';
import type { Task, TaskView } from '../../shared/model/tasks.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { dueText } from './time.ts';

const NOTES_CHARS = 3000;
const MAX_STEPS = 30;
const MAX_TRIED = 6;
const MAX_FACTS = 8;

/** Titles of the parent chain, nearest first (max 4). */
export function goalChain(services: RuntimeServices, task: Task): string[] {
  const out: string[] = [];
  const seen = new Set([task.id]);
  let parentId = task.parentId;
  while (parentId && !seen.has(parentId) && out.length < 4) {
    seen.add(parentId);
    const parent = services.tasks.get(parentId);
    if (!parent) break;
    out.push(parent.title);
    parentId = parent.parentId;
  }
  if (!out.length && task.goal) out.push(task.goal);
  return out;
}

/**
 * Checklist steps of a task. TaskView only loads steps for top-level tasks, so a delegated
 * sub-task's own children are looked up in its chat.
 */
export function stepsOf(services: RuntimeServices, task: TaskView): Task[] {
  if (task.steps.length || !task.parentId) return task.steps;
  try {
    return services.tasks.list({ conversationId: task.conversationId, includeSteps: true, limit: 1000 })
      .filter((item) => item.parentId === task.id)
      .sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

export function stepLine(step: Task): string {
  const mark = step.status === 'done' ? 'x' : step.status === 'cancelled' ? '-' : ' ';
  const extra = step.status !== 'done' && step.status !== 'open' && step.status !== 'cancelled' ? ` (${step.status})` : '';
  return `- [${mark}] ${excerpt(step.title, 160)}${extra} · ${step.id}`;
}

export function renderTask(services: RuntimeServices, task: TaskView, zone: string): string {
  const now = services.clock.now();
  const head = [task.id, task.status];
  if (task.priority > 0) head.push(task.priority === 2 ? 'urgent' : 'high priority');
  if (task.dueAt) head.push(`due ${dueText(task.dueAt, zone, now)}`);
  if (task.mode) head.push(`mode ${task.mode}`);
  if (task.attempts) head.push(`${task.attempts} turn${task.attempts === 1 ? '' : 's'} so far`);
  const lines = [`## Current task`, head.join(' · '), `Title: ${task.title}`];
  const chain = goalChain(services, task);
  if (chain.length) lines.push(`Part of: ${chain.map((title) => excerpt(title, 100)).join(' ← ')}`);
  lines.push(task.doneWhen ? `Done when: ${task.doneWhen}` : 'Done when: not set – I define it (tasks.update doneWhen) before I start larger work.');
  if (task.notes.trim()) {
    const notes = task.notes.trim();
    lines.push(`Notes:\n${notes.length > NOTES_CHARS ? `${notes.slice(0, NOTES_CHARS)}… (truncated)` : notes}`);
  }
  const steps = stepsOf(services, task);
  if (steps.length) {
    lines.push(`Steps (${steps.filter((step) => step.status === 'done').length}/${steps.length} done):`);
    lines.push(...steps.slice(0, MAX_STEPS).map(stepLine));
    if (steps.length > MAX_STEPS) lines.push(`(+${steps.length - MAX_STEPS} more steps)`);
  }
  const ledger = task.ledger ?? {};
  if (ledger.plan?.length) lines.push(`Plan:\n${ledger.plan.slice(0, 12).map((item, index) => `${index + 1}. ${excerpt(item, 160)}`).join('\n')}`);
  const tried = (ledger.tried ?? []).slice(-MAX_TRIED);
  if (tried.length) lines.push(`Tried so far:\n${tried.map((item) => `- ${excerpt(item.approach, 160)} → ${item.outcome}`).join('\n')}`);
  const facts = (ledger.facts ?? []).slice(-MAX_FACTS);
  if (facts.length) lines.push(`Facts:\n${facts.map((fact) => `- ${excerpt(fact, 200)}`).join('\n')}`);
  if (ledger.escalation && ledger.escalation !== 'none') lines.push(`Escalation level: ${ledger.escalation.replace('_', ' ')}`);
  if (task.waitingOn) lines.push(`Waiting on ${task.waitingOn.kind}${task.waitingOn.id ? ` ${task.waitingOn.id}` : ''}: ${excerpt(task.waitingOn.reason, 200)}`);
  if (task.result) {
    const evidence = task.result.evidence.map((item) => item.label).slice(0, 6).join('; ');
    lines.push(`Result: ${excerpt(task.result.summary, 300)} (${task.result.verification.replace(/_/g, ' ')})${evidence ? ` · evidence: ${evidence}` : ''}`);
  }
  return lines.join('\n');
}

export function currentTaskSection(services: RuntimeServices, taskId: string, zone: string): string {
  const task = services.tasks.get(taskId);
  return task ? renderTask(services, task, zone) : '';
}
