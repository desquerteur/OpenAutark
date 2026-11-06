// The checklist of a task in the ChatGPT-photo style: round circles (number while open, check
// icon when done – never strike-through alone), small grey secondary lines, no card per item.
// The human ticks their own steps; the owner agent notices at its next turn (T14).
// Owns: step rows and the toggle. Never: lets the human tick an agent's step (agents report
// their own work with evidence).

import { useState } from 'preact/hooks';
import type { Task, TaskView } from '../../shared/model/tasks.ts';
import { newId } from '../../shared/ids.ts';
import { Icon, Spinner } from '../lib/ui.tsx';
import { agentName } from '../lib/store.ts';
import { rpc } from '../lib/rpc.ts';
import { toastError } from '../lib/toasts.ts';
import { plainPreview } from '../lib/format.ts';
import { STATUS_LABELS, canToggleStep, orderedSteps, ownerOf } from './model.ts';
import { putTask } from './task-cache.ts';

function ownerText(step: Task): string {
  const owner = ownerOf(step);
  return owner.kind === 'agent' || owner.kind === 'person' ? agentName(owner.id) : owner.kind === 'human' ? 'You' : '';
}

function secondary(step: Task): string {
  const parts: string[] = [];
  const owner = ownerText(step);
  if (owner) parts.push(owner);
  if (step.status !== 'open' && step.status !== 'done') parts.push(STATUS_LABELS[step.status]);
  if (step.waitingOn && step.status !== 'done') parts.push(plainPreview(step.waitingOn.reason, 80));
  else if (step.notes) parts.push(plainPreview(step.notes, 80));
  return parts.join(' · ');
}

function StepRow(props: { step: Task; index: number; task: TaskView }) {
  const { step } = props;
  const parentId = props.task.id;
  const [busy, setBusy] = useState(false);
  const done = step.status === 'done';
  const toggleable = canToggleStep(step);
  const toggle = async () => {
    setBusy(true);
    try {
      const view = done
        ? await rpc.call('tasks.setStatus', { id: step.id, status: 'open' })
        : await rpc.call('tasks.complete', { id: step.id, clientId: newId('up') });
      putTask(view);
      if (done) putTask(await rpc.call('tasks.get', { id: parentId })); // reopening does not re-emit the parent
    } catch (error) {
      toastError(error, 'Could not update the step');
    } finally {
      setBusy(false);
    }
  };
  const circle = (
    <span class="step-circle" data-status={step.status} aria-hidden="true">
      {busy ? <Spinner size={12} /> : done ? <Icon name="check" size={11} /> : step.status === 'cancelled' ? <Icon name="x" size={10} /> : <span class="step-number tabular">{props.index + 1}</span>}
    </span>
  );
  const line = secondary(step);
  return (
    <li class={`step-row${done ? ' done' : ''}${step.status === 'cancelled' ? ' cancelled' : ''}`}>
      {toggleable
        ? <button type="button" class="step-toggle" role="checkbox" aria-checked={done} aria-label={`${done ? 'Reopen' : 'Done'}: ${step.title}`} disabled={busy} onClick={(event) => { event.stopPropagation(); void toggle(); }}>{circle}</button>
        : circle}
      <span class="step-text">
        <span class="step-title">{step.title}<span class="sr-only">{done ? ' (done)' : ` (${STATUS_LABELS[step.status]})`}</span></span>
        {line && <span class="step-sub">{line}</span>}
      </span>
    </li>
  );
}

export function StepList(props: { task: TaskView }) {
  const steps = orderedSteps(props.task.steps);
  if (!steps.length) return null;
  return (
    <ol class="step-list" aria-label="Steps">
      {steps.map((step, index) => <StepRow key={step.id} step={step} index={index} task={props.task} />)}
    </ol>
  );
}
