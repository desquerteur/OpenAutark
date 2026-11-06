// My day's "Handed off" group (B-041 §4.1): collapsed with its count, what the person asked for that
// agents, the team or colleagues own now (lib/day-store.ts handedOff – open, and done since last
// evening), one row each with its state – "Mara working", "Prepared – your step: …" (a click opens
// that step in Needs you), "Done ✓". A row opens the task.
// Owns: the group's rows. Never: loads the list (day-store) or decides the state text (day-groups.ts).

import type { TaskView } from '../../shared/model/tasks.ts';
import { agentName } from '../lib/store.ts';
import { personName } from '../lib/people.ts';
import { openTask } from '../tasks/jump.ts';
import type { HandedOffRow } from './day-groups.ts';
import { revealTodo } from './day-state.ts';

/** Who owns a handed-off task: its agent, the colleague, else undefined (no owner yet). */
export function ownerName(task: Pick<TaskView, 'assigneeKind' | 'assigneeId'>): string | undefined {
  if (!task.assigneeId) return task.assigneeKind === 'team' ? 'the team' : undefined;
  if (task.assigneeKind === 'agent') return agentName(task.assigneeId);
  return personName(task.assigneeId) ?? agentName(task.assigneeId);
}

export function HandedOffList(props: { id?: string; rows: Array<HandedOffRow<TaskView>> }) {
  return (
    <ul class="day-handed" id={props.id} aria-label="Handed off">
      {props.rows.map(({ task, text, step, done }) => (
        <li key={task.id} class={`day-handed-row${done ? ' done' : ''}`}>
          <span class="day-handed-text">
            <button type="button" class="day-handed-title" onClick={() => openTask(task)}>{task.title}</button>
            {step
              ? <button type="button" class="day-handed-state step" onClick={() => revealTodo(step.id)}>{text}</button>
              : <span class="day-handed-state">{text}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
