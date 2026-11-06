// The Work view (#/tasks[?owner=][&task=], B-078 D10 – owner 06.11.: "wenn die mich bräuchten, müsste da irgendwas
// stehen. Und wenn die mich nicht brauchen, … kriegen sie es ja alleine hin"): on top the quick task composer
// (TaskComposer: tasks.quickCreate, the field is free again at once; posts on their way below it), then two regions
// told apart by shape (WorkRegions.tsx): "For you" – accent cards of the agents' work that needs the person, each with
// its question inline – and the report, one quiet paragraph of the team's side work and facts of the last three days
// (work-model.ts forYou, report). Nothing else by default: the sidebar's People & agents (#/tasks?owner=<id|team>, O5)
// shows one owner's open work as slim rows, and the search finds every open task (slim rows) and report line.
// Older #/tasks/<filter> links open this plain view. Every card and row has the task menu on right click / long press.
// On a computer the composer sits in a band above the list (the list scrolls under it), so a task's detail – lying
// over the list below the band – never covers it.
// The header (lib/header.tsx, B-044) is one row over the list and the detail: "Work", the search beside it in the
// title cell and, narrowed to an owner, "· Mira ✕" (a click shows For you and the report again). On the phone the
// frame's top row carries the same search (workSearchHeader via shell/views.ts); the removable owner chip sits on top
// of the list.
// The selected task is the route's ?task= (jump.ts selectTask/closeTask: Back closes it, a sidebar click clears it):
// its detail lies over the list's right side on wide windows, below the composer band, and takes the list's place on
// narrow ones only while it is open (container query in tasks.css).
// Owns: the regions' order, the report window's loading, the header data and the search. Never: a second task store
// (open tasks come from the store, finished ones from the done store) or a selection outside the route.

import { useEffect, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { Chip, EmptyState, Icon, Spinner } from '../lib/ui.tsx';
import { Header, HeaderSearch, searchCell } from '../lib/header.tsx';
import type { HeaderProps, HeaderSearchState } from '../lib/header.tsx';
import { agentName, isMobile, loaded, route, tasks } from '../lib/store.ts';
import { navigate } from '../lib/router.ts';
import { isPersonSession } from '../lib/people.ts';
import { DESTINATIONS } from '../lib/vocab.ts';
import { DAY_MS, REPORT_DAYS, forYou, matchingWork, ownerChipLabel, ownerWork, report, withTask, workRoute } from './model.ts';
import { TaskComposer } from './TaskComposer.tsx';
import { PendingPosts } from './PendingPosts.tsx';
import { TaskDetail } from './TaskDetail.tsx';
import { ForYouCards, SlimRows, WorkReport } from './WorkRegions.tsx';
import { doneTasks, ensureDone } from './done-store.ts';
import { closeTask, selectTask, useWorkClock } from './jump.ts';

/** The local search – one state for the computer's header and the phone's top row. */
const workSearch = signal({ open: false, query: '' });

/** The search as header data; its placeholder names the owner the list is narrowed to. */
function searchState(owner: string | undefined): HeaderSearchState {
  const state = workSearch.value;
  const name = owner ? ownerChipLabel(owner, agentName) : '';
  return {
    label: 'Search tasks', open: state.open, query: state.query,
    onQuery: (query) => { workSearch.value = { ...workSearch.peek(), query }; },
    onOpenChange: (open) => { workSearch.value = { ...workSearch.peek(), open }; },
    placeholder: name ? `Search · ${name}` : 'Search',
  };
}

/** The phone's top row over Work (shell/views.ts): its magnifier opens this search in the title's place. */
export function workSearchHeader(): HeaderProps {
  const current = route.value;
  return { title: '', search: searchState(current.view === 'tasks' ? current.owner : undefined) };
}

/** Work's header: its name, "· Mira ✕" while narrowed to an owner, the search field beside them (the name stays). */
function workHeader(props: { owner?: string; onEveryone: () => void }): HeaderProps {
  const name = props.owner ? ownerChipLabel(props.owner, agentName) : '';
  const search = searchState(props.owner);
  return {
    zone: 'main', class: 'tasks-header',
    title: (
      <span class="tasks-head">
        <h2 class="frame-header-text">{DESTINATIONS.tasks}</h2>
        {props.owner && (
          <button type="button" class="tasks-owner" title="Show For you and the report" onClick={props.onEveryone}>
            <span class="tasks-owner-name">· {name}</span><Icon name="x" size={12} />
          </button>
        )}
        {search.open && (
          <span class="tasks-head-search">
            <Icon name="magnifying-glass" size={14} class="tasks-head-search-icon" />
            <HeaderSearch {...search} />
          </span>
        )}
      </span>
    ),
    near: [searchCell(search)], // right after the title, so no cell of this view lies in the row above the global pane
  };
}

type DoneState = 'loading' | 'ready' | 'error';

/** The report's finished work: loaded once per window, retried on request. */
export function useReportWork(): { state: DoneState; retry: () => void } {
  const [state, setState] = useState<DoneState>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState('loading');
    ensureDone({ since: Date.now() - REPORT_DAYS * DAY_MS }).then(() => { if (live) setState('ready'); }, () => { if (live) setState('error'); });
    return () => { live = false; };
  }, [attempt]);
  return { state, retry: () => setAttempt(attempt + 1) };
}

export function TasksView() {
  const current = route.value.view === 'tasks' ? route.value : undefined;
  const owner = current?.owner;
  const selected = current?.task ?? null;
  const now = useWorkClock();
  const scope = { keepOwn: isPersonSession() };
  const { query } = workSearch.value;
  const done = useReportWork();
  const select = (id: string) => (id === selected ? closeTask() : selectTask(id));

  const cards = owner ? [] : forYou(tasks.value, query, scope);
  const rows = owner ? ownerWork(tasks.value, owner, query, scope) : matchingWork(tasks.value, query, scope);
  const lines = owner ? [] : report(doneTasks.value, now, { scope, query });
  const empty = !cards.length && !rows.length && !lines.length;
  const retry = <button type="button" class="text-button inline" onClick={done.retry}>Retry</button>;
  const body = (
    <>
      <ForYouCards list={cards} selected={selected} onSelect={select} />
      <SlimRows list={rows} selected={selected} onSelect={select} label={owner ? `${ownerChipLabel(owner, agentName)}'s work` : 'Matching work'} />
      <WorkReport lines={lines} now={now} onSelect={select} />
      {empty && (!loaded.value ? <Spinner />
        : <EmptyState>{query ? 'No matching tasks.' : owner ? 'No open work.' : 'Nothing needs you. The team\'s report shows up here as work gets done.'}</EmptyState>)}
      {!owner && done.state === 'error' && <p class="tasks-done-failed muted">The report could not be loaded. {retry}</p>}
    </>
  );

  const mobile = isMobile.value;
  const everyone = () => navigate(withTask(workRoute(), selected ?? undefined));
  return (
    <div class={`tasks-view${selected ? ' has-detail' : ''}`}>
      {!mobile && <Header {...workHeader({ owner, onEveryone: everyone })} />}
      <div class="tasks-body">
        <section class="tasks-main" aria-label="Work">
          {!mobile && <div class="tasks-top"><div class="tasks-column"><TaskComposer /></div></div>}
          <div class="tasks-list">
            <div class="tasks-scroll">
              <div class="tasks-column">
                {mobile && owner && (
                  <Chip icon="x" tone="accent" class="tasks-owner-chip" title="Show For you and the report" onClick={everyone}>
                    {ownerChipLabel(owner, agentName)}
                  </Chip>
                )}
                {mobile && <TaskComposer />}
                <PendingPosts />
                {body}
              </div>
            </div>
            {selected && <TaskDetail key={selected} taskId={selected} onClose={closeTask} />}
          </div>
        </section>
      </div>
    </div>
  );
}
