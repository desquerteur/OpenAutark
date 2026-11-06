// checkpoint(): the portable Handoff for delegation, mode switches and model changes - goal, what is verified (done
// steps, evidence), what is open, the next concrete step, artefacts (evidence refs, attachments and file blocks of recent
// messages) and constraints (approaches that failed - never a limit or outage, which says nothing about the approach -
// and known facts of the task).
// Owns: deriving those fields from the task row, its ledger/result and the last messages.
// Never: copies whole conversations or reasoning, or marks anything verified that the task row does not record as done.

import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import type { Handoff } from '../../shared/model/knowledge.ts';
import type { Message } from '../../shared/model/chat.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import { uiBlocksOf } from '../../shared/blocks/parse.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { isOutage } from '../agents/outages.ts';
import { goalChain, stepsOf } from './task-text.ts';

const RECENT = 20;
const MAX_ARTIFACTS = 12;
const MAX_CONSTRAINTS = 16;

function artifactsOf(services: RuntimeServices, task: TaskView | undefined, recent: Message[]): Handoff['artifacts'] {
  const out: Handoff['artifacts'] = [];
  const seen = new Set<string>();
  const add = (label: string, ref: string | undefined) => {
    if (!ref || seen.has(ref) || out.length >= MAX_ARTIFACTS) return;
    seen.add(ref);
    out.push({ label: excerpt(label || ref, 120), ref });
  };
  for (const item of task?.result?.evidence ?? []) {
    if (item.ref && item.kind !== 'note' && item.kind !== 'check') add(item.label, item.ref);
  }
  for (const message of [...recent].reverse()) {
    for (const file of message.attachments) {
      let ref = `file:${file.fileId}`;
      try { ref = services.files.path(file.fileId); } catch { /* keep the id form */ }
      add(file.name, ref);
    }
    if (message.authorKind !== 'agent' || !message.body.includes('```ui')) continue;
    for (const { block } of uiBlocksOf(message.body)) {
      if (block.type === 'file' && typeof block.path === 'string') add(typeof block.label === 'string' ? block.label : path.basename(block.path), block.path);
    }
  }
  return out;
}

/** The human's newest request; task anchors count only when no task is being handed off. */
function lastHumanRequest(recent: Message[], withTasks: boolean): Message | undefined {
  return [...recent].reverse().find((message) => message.authorKind === 'human' && (message.kind === 'text' || (withTasks && message.kind === 'task')) && message.body.trim());
}

export function buildCheckpoint(services: RuntimeServices, input: { agentId: string; taskId?: string; conversationId?: string }): Handoff {
  const task = input.taskId ? services.tasks.get(input.taskId) : undefined;
  const conversationId = input.conversationId ?? task?.conversationId;
  const recent = conversationId ? services.chats.messages(conversationId, { limit: RECENT }) : [];
  const conversation = conversationId ? services.chats.get(conversationId) : undefined;
  const human = lastHumanRequest(recent, !task);

  if (!task) {
    const goal = human ? excerpt(human.body, 300) : conversation ? `Continue the work in "${conversation.title || conversationId}"` : 'Continue the current work';
    const loose: Handoff = {
      goal,
      verified: [],
      open: human ? [`Latest request: ${excerpt(human.body, 300)}`] : [],
      next: human ? 'Answer the latest request.' : 'Continue where the conversation left off.',
      artifacts: artifactsOf(services, undefined, recent),
    };
    return loose;
  }

  const chain = goalChain(services, task);
  const goal = chain.length ? `${task.title} (part of: ${excerpt(chain[0], 160)})` : task.title;
  const verified: string[] = [];
  const open: string[] = [];
  const steps = stepsOf(services, task);
  for (const step of steps) {
    if (step.status === 'done') verified.push(`Step done: ${excerpt(step.title, 160)}${step.result?.summary ? ` – ${excerpt(step.result.summary, 160)}` : ''}`);
    else if (step.status !== 'cancelled') open.push(`Step: ${excerpt(step.title, 160)}${step.status !== 'open' ? ` (${step.status})` : ''}`);
  }
  if (task.result) {
    verified.push(`Result (${task.result.verification.replace(/_/g, ' ')}): ${excerpt(task.result.summary, 300)}`);
    for (const item of task.result.evidence.slice(0, 8)) verified.push(`Evidence – ${item.kind}: ${excerpt(item.label, 160)}${item.ref ? ` (${item.ref})` : ''}`);
  }
  const done = task.status === 'done' || task.status === 'cancelled';
  if (!done && task.doneWhen) open.push(`Meet the done-condition: ${task.doneWhen}`);
  if (task.waitingOn) open.push(`Waiting on ${task.waitingOn.kind}: ${excerpt(task.waitingOn.reason, 200)}`);
  if (human && human.createdAt >= task.createdAt) open.push(`Latest request in the chat: ${excerpt(human.body, 300)}`);

  const ledger = task.ledger ?? {};
  const firstOpenStep = steps.find((step) => step.status !== 'done' && step.status !== 'cancelled');
  let next: string;
  if (done) next = task.status === 'done' ? 'Report the result and set up follow-ups.' : 'Nothing – the task was cancelled.';
  else if (firstOpenStep) next = `Do the step "${excerpt(firstOpenStep.title, 160)}".`;
  else if (task.waitingOn) next = `Check whether this is resolved: ${excerpt(task.waitingOn.reason, 160)}.`;
  else if (ledger.plan?.length) next = excerpt(ledger.plan[0], 200);
  else next = task.doneWhen ? 'Finish the work, check the done-condition and complete the task with evidence.' : 'Define the done-condition, do the work and complete the task with evidence.';

  const constraints: string[] = [];
  for (const item of (ledger.tried ?? []).filter((entry) => entry.outcome !== 'done' && entry.outcome !== 'waiting' && !isOutage(entry.outcome)).slice(-5)) {
    if (item.approach && item.approach !== item.outcome) constraints.push(`Tried without success: ${excerpt(item.approach, 160)} (${item.outcome})`);
  }
  for (const fact of (ledger.facts ?? []).slice(-5)) constraints.push(`Known: ${excerpt(fact, 200)}`);

  const handoff: Handoff = { goal, verified, open, next, artifacts: artifactsOf(services, task, recent) };
  if (constraints.length) handoff.constraints = constraints.slice(0, MAX_CONSTRAINTS);
  return handoff;
}
