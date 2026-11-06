// Work's two regions (B-078 D10), told apart by shape, not by labels (owner 06.11.: "anderes Design … andere
// Stärke … Formen und Farben"): "For you" – large accent-bordered cards, each with the agent's question right in it
// (the same AskBlock as in the chat and on My day; without one, what the work waits on and a click to its detail) –
// and the report: one quiet prose block, no rows, of what the team handled on the side and what everyone should
// know (work-model.ts report); each sentence opens its task. Also the slim rows of one owner's open work.
// Owns: these regions' markup. Never: decides what needs the person or what the report says (work-model.ts does).

import type { TaskView } from '../../shared/model/tasks.ts';
import { AskBlock } from '../blocks/AskBlock.tsx';
import { agentName } from '../lib/store.ts';
import { listTime, plainPreview } from '../lib/format.ts';
import { useContextMenu } from '../lib/context-menu.tsx';
import { WORK_REGIONS } from '../lib/vocab.ts';
import { askTargetOf } from './model.ts';
import { openQuestions } from './center-model.ts';
import { OwnerBadge } from './parts.tsx';
import { TaskRow } from './TaskRow.tsx';
import { taskMenu } from './task-menu.ts';
import type { ReportLine } from './work-model.ts';

/** One card: owner and title (a click opens the detail), then the question to answer right here. */
function ForYouCard(props: { task: TaskView; selected: boolean; onSelect: (id: string) => void }) {
  const { task } = props;
  const questions = openQuestions(task.steps);
  const menu = useContextMenu(() => taskMenu(task));
  const owner = task.assigneeId ? agentName(task.assigneeId) : '';
  return (
    <li class={`foryou-card${props.selected ? ' selected' : ''}`} {...menu}>
      <button type="button" class="foryou-card-head" aria-current={props.selected ? 'true' : undefined} onClick={() => props.onSelect(task.id)}>
        <OwnerBadge task={task} size={28} working={task.running} interactive={false} />
        <span class="foryou-card-text">
          <span class="foryou-card-title">{task.title}</span>
          <span class="foryou-card-meta">{[owner, task.waitingOn?.reason ? plainPreview(task.waitingOn.reason, 120) : ''].filter(Boolean).join(' · ')}</span>
        </span>
      </button>
      {questions.map((step) => (
        <div key={step.id} class="foryou-card-ask">
          <AskBlock block={step.widget!} target={askTargetOf(step)} bare />
        </div>
      ))}
    </li>
  );
}

export function ForYouCards(props: { list: TaskView[]; selected: string | null; onSelect: (id: string) => void }) {
  if (!props.list.length) return null;
  return (
    <section class="foryou" aria-label={WORK_REGIONS.forYou}>
      <ul class="foryou-cards">
        {props.list.map((task) => <ForYouCard key={task.id} task={task} selected={task.id === props.selected} onSelect={props.onSelect} />)}
      </ul>
    </section>
  );
}

/** A line as a sentence: ends with a full stop unless it already ends with one. */
const sentence = (text: string): string => (/[.!?…:]$/.test(text) ? text : `${text}.`);

/** The report: one quiet paragraph; each sentence opens its task. */
export function WorkReport(props: { lines: Array<ReportLine<TaskView>>; now: number; onSelect: (id: string) => void; limit?: number }) {
  const lines = props.limit ? props.lines.slice(0, props.limit) : props.lines;
  if (!lines.length) return null;
  return (
    <section class="work-report" aria-label={WORK_REGIONS.report}>
      <p class="work-report-text">
        {lines.map((line) => (
          <button key={line.key} type="button" class="work-report-line" title={`${line.task.title} · ${listTime(line.at, props.now)}`}
            onClick={() => props.onSelect(line.task.id)}>
            {sentence(line.text)}
          </button>
        ))}
      </p>
    </section>
  );
}

/** One owner's open work (or the search's other matches): slim muted rows. */
export function SlimRows(props: { list: TaskView[]; selected: string | null; onSelect: (id: string) => void; label: string }) {
  if (!props.list.length) return null;
  return (
    <ul class="task-rows slim" aria-label={props.label}>
      {props.list.map((task) => <TaskRow key={task.id} task={task} selected={task.id === props.selected} onSelect={props.onSelect} />)}
    </ul>
  );
}
