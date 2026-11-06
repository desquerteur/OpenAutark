// Work in the side pane (the pane's "Work" tab, workspace/WorkspacePane.tsx): the same regions as the Work view
// (B-078 D10: the quick task composer, the For-you cards and the report – work-model.ts forYou, report;
// WorkRegions.tsx), with no menu of its own, so the main view stays where it is. A click opens the task's detail
// here: it takes the list's place in the narrow pane and lies beside it in full view (tasks.css, the container
// `tasks-view`). Only while it is shown.
// Owns: the pane's work column and its selection. Never: a second task store or the route.

import { useState } from 'preact/hooks';
import { isPersonSession } from '../lib/people.ts';
import { can } from '../lib/session.ts';
import { loaded, tasks } from '../lib/store.ts';
import { EmptyState, Spinner } from '../lib/ui.tsx';
import { doneTasks } from './done-store.ts';
import { useWorkClock } from './jump.ts';
import { forYou, report } from './model.ts';
import { PendingPosts } from './PendingPosts.tsx';
import { TaskComposer } from './TaskComposer.tsx';
import { TaskDetail } from './TaskDetail.tsx';
import { useReportWork } from './TasksView.tsx';
import { ForYouCards, WorkReport } from './WorkRegions.tsx';

export function WorkIndex() {
  const [selected, setSelected] = useState<string | null>(null);
  const now = useWorkClock();
  const done = useReportWork();
  const scope = { keepOwn: isPersonSession() };
  const cards = forYou(tasks.value, '', scope);
  const lines = report(doneTasks.value, now, { scope });
  const select = (id: string) => setSelected(id === selected ? null : id);
  return (
    <div class={`tasks-view pane-work${selected ? ' has-detail' : ''}`}>
      <div class="tasks-body">
        <section class="tasks-main" aria-label="Work">
          {can('tasks.quickCreate') && <div class="tasks-top"><div class="tasks-column"><TaskComposer autoFocus={false} /></div></div>}
          <div class="tasks-list">
            <div class="tasks-scroll">
              <div class="tasks-column">
                <PendingPosts />
                <ForYouCards list={cards} selected={selected} onSelect={select} />
                <WorkReport lines={lines} now={now} onSelect={select} />
                {!cards.length && !lines.length && (loaded.value ? <EmptyState>Nothing needs you.</EmptyState> : <Spinner />)}
                {done.state === 'error' && <p class="tasks-done-failed muted">The report could not be loaded. <button type="button" class="text-button inline" onClick={done.retry}>Retry</button></p>}
              </div>
            </div>
            {selected && <TaskDetail key={selected} taskId={selected} onClose={() => setSelected(null)} />}
          </div>
        </section>
      </div>
    </div>
  );
}
