// The documentation of a finished task (T6, concept 26): its finish time, the summary, "Also handled …" (the
// team's report lines – Work's report collects them, work-model.ts report) and the follow-up chips (each schedule
// chip can be paused or cancelled, a task chip opens it). B-078 D10: no verification mark and no evidence chips –
// the agent side keeps its verification; the person reads what was done.
// Owns: result rendering and the follow-up actions. Never: shows unverified work as verified.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { TaskResult, TaskView } from '../../shared/model/tasks.ts';
import { Chip, Icon, Menu } from '../lib/ui.tsx';
import type { MenuSection } from '../lib/ui.tsx';
import { toastError } from '../lib/toasts.ts';
import { listTime, fullDate } from '../lib/format.ts';
import { Markdown } from '../blocks/markdown.tsx';
import { ensureSchedules, scheduleMenu, schedules, schedulesLoaded } from './schedules.ts';
import { fetchTask } from './task-cache.ts';
import { openTask } from './jump.ts';

function ScheduleChip(props: { scheduleId: string; label: string }) {
  const ref = useRef<HTMLSpanElement>(null); // menu anchor (Chip itself does not forward refs)
  const [open, setOpen] = useState(false);
  useEffect(() => { ensureSchedules(); }, []);
  const item = schedules.value.find((entry) => entry.id === props.scheduleId);
  const sections: MenuSection[] = item ? scheduleMenu(item) : [];
  const gone = schedulesLoaded.value && !item; // finished or cancelled schedules no longer exist
  return (
    <span class="followup-anchor" ref={ref}>
      <Chip class={`followup-chip${gone ? ' ended' : ''}${item && !item.active ? ' paused' : ''}`}
        title={item?.nextAt ? `Next: ${fullDate(item.nextAt)}` : gone ? 'Ended' : undefined}
        disabled={gone} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {props.label}{item && !item.active ? ' · paused' : ''}
      </Chip>
      <Menu anchor={ref.current} open={open && sections.length > 0} onClose={() => setOpen(false)} sections={sections} placement="bottom-start" label={props.label} />
    </span>
  );
}

function TaskChip(props: { taskId: string; label: string }) {
  const open = async () => {
    try {
      const task = await fetchTask(props.taskId);
      if (task) openTask(task);
    } catch (error) { toastError(error, "Couldn't open the task"); }
  };
  return <Chip class="followup-chip" onClick={() => void open()}>{props.label}</Chip>;
}

function FollowUps(props: { items: NonNullable<TaskResult['followUps']> }) {
  return (
    <div class="task-followups" aria-label="Follow-ups">
      {props.items.map((item, index) => item.scheduleId
        ? <ScheduleChip key={item.scheduleId} scheduleId={item.scheduleId} label={item.label} />
        : item.taskId
          ? <TaskChip key={item.taskId} taskId={item.taskId} label={item.label} />
          : <span key={index} class="chip followup-chip static"><Icon name="clock" size={15} /><span class="chip-label">{item.label}</span></span>)}
    </div>
  );
}

export function ResultView(props: { task: TaskView }) {
  const { task } = props;
  const result = task.result;
  if (!result) return null;
  return (
    <section class="task-result" aria-label="Result">
      {task.completedAt && (
        <div class="task-result-head">
          <span class="task-result-label">Result</span>
          <time class="muted tabular" title={fullDate(task.completedAt)}>{listTime(task.completedAt)}</time>
        </div>
      )}
      <Markdown text={result.summary} class="task-result-summary" />
      {!!result.alsoHandled?.length && (
        <div class="task-result-also">
          <span class="task-result-label">Also handled</span>
          <ul>{result.alsoHandled.map((line, index) => <li key={index}>{line}</li>)}</ul>
        </div>
      )}
      {!!result.followUps?.length && <FollowUps items={result.followUps} />}
    </section>
  );
}
