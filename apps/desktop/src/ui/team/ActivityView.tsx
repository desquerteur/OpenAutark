// Pane tab › Activity: one overview for everyone, people and agents side by side – per member what they finished today,
// what they are on right now, how much is open and how much is stuck (team/activity-model.ts), with the totals on top:
// Robin's "Dashboard über alles, was alle machen", the admin view of what everyone did. People first (the org order: the
// top, then whom they lead), then the agents by name. A row opens that member's page; "now" opens the task (without
// anything running: an agent's status line, a person's title). Work nobody owns yet is a last row "No owner yet" while
// there is any (the totals then match Work and Home), and each count opens that part of Work for the member
// (#/tasks/stuck?owner=…, #/tasks?owner=…, #/tasks/done?owner=…). The counts follow Work's scope (tasks/work-model.ts
// onWork, as Work and Home count): the viewer's own to-dos are My day's, so no total here says more than Work and Home,
// and no count opens an empty list.
// Data: the store's open tasks and to-dos, the done store (loaded from the start of today in the profile's zone, then
// kept fresh by task events) and the live runs – no new RPC, no polling; the day clock moves "today" at midnight.
// Owns: the activity overview. Never: a second task store, or a control this connection may not use.

import { useEffect, useState } from 'preact/hooks';
import type { Agent } from '../../shared/model/org.ts';
import { dayClock, dayRange, dayZone, localDate } from '../lib/day-store.ts';
import { isPersonSession, peopleMap } from '../lib/people.ts';
import { go } from '../lib/router.ts';
import { can } from '../lib/session.ts';
import { activity, agentName, agents, tasks, todos } from '../lib/store.ts';
import { AgentAvatar, EmptyState } from '../lib/ui.tsx';
import { doneTasks, ensureDone } from '../tasks/done-store.ts';
import { openTask } from '../tasks/jump.ts';
import { onWork } from '../tasks/work-model.ts';
import type { ActivityMember, ActivityRow } from './activity-model.ts';
import { NO_OWNER, activityRows, activityTotals } from './activity-model.ts';
import { peopleTree } from './org-state.ts';
import { agentLine, AgentStatusAvatar, AiTag } from './parts.tsx';
import type { PersonEntry } from './people-model.ts';

/** People in org order (the top, then whom each leads), then the active agents by name. */
function members(tree: readonly PersonEntry[]): ActivityMember[] {
  const out: ActivityMember[] = [];
  const walk = (entry: PersonEntry) => { if (entry.person.status !== 'revoked') out.push({ id: entry.person.id, kind: 'person' }); entry.people.forEach(walk); };
  tree.forEach(walk);
  if (!out.length) out.push({ id: 'human', kind: 'person' }); // the people list is not readable here: the caller alone
  const list = agents.value.filter((agent) => !agent.archivedAt).sort((a, b) => a.name.localeCompare(b.name));
  return [...out, ...list.map((agent) => ({ id: agent.id, kind: 'agent' as const })), NO_OWNER];
}

/** A count; with `onOpen` (Work may be listed here) a link to that part of Work. */
function Count(props: { value: number; label: string; tone?: 'stuck'; onOpen?: () => void }) {
  const cls = `activity-count${props.value === 0 ? ' zero' : ''}${props.tone && props.value > 0 ? ` ${props.tone}` : ''}`;
  const body = (
    <>
      <span class="activity-count-value tabular">{props.value}</span>
      <span class="activity-count-label">{props.label}</span>
    </>
  );
  const title = `${props.value} ${props.label.toLowerCase()}`;
  return props.onOpen
    ? <button type="button" class={`${cls} activity-count-link`} title={title} onClick={props.onOpen}>{body}</button>
    : <span class={cls} title={title}>{body}</span>;
}

/** The agent's resting line, unless it only repeats the name (an agent called "Writer" in the role Writer). */
function idleLine(agent: Agent): string {
  const line = agentLine(agent);
  return line === agent.name ? '' : line;
}

function MemberRow(props: { row: ActivityRow; doneKnown: boolean }) {
  const { member, now } = props.row;
  const agent = member.kind === 'agent' ? agents.value.find((entry) => entry.id === member.id) : undefined;
  const nobody = member.kind === 'team';
  const open = () => (nobody ? go.tasks(undefined, member.id) : agent ? go.agent(member.id) : go.person(member.id));
  const work = can('tasks.list') ? (filter?: string) => () => go.tasks(filter, member.id) : undefined;
  return (
    <li class="activity-row">
      <span class="activity-who">
        {nobody ? <span class="activity-nobody" aria-hidden="true" /> : agent ? <AgentStatusAvatar agent={agent} size={32} onClick={open} /> : <AgentAvatar agentId={member.id} size={32} onClick={open} />}
        <span class="activity-text">
          <span class="activity-name-line">
            <button type="button" class="org-name" onClick={open}>{nobody ? 'No owner yet' : agentName(member.id)}</button>
            {agent && <AiTag />}
          </span>
          {now
            ? (
              <button type="button" class="activity-now" title={now.note ? `${now.title} · ${now.note}` : now.title}
                disabled={!now.taskId} onClick={() => { const task = tasks.value.find((entry) => entry.id === now.taskId) ?? todos.value.find((entry) => entry.id === now.taskId); if (task) openTask(task); }}>
                {now.title}{now.note && <span class="activity-note"> · {now.note}</span>}
              </button>
            )
            : <span class="activity-idle">{agent ? idleLine(agent) : peopleMap.value.get(member.id)?.title || ''}</span>}
        </span>
      </span>
      <span class="activity-counts">
        {props.doneKnown && <Count value={props.row.doneToday} label="Done today" onOpen={work?.('done')} />}
        <Count value={props.row.open} label="Open" onOpen={work?.()} />
        <Count value={props.row.stuck} label="Stuck" tone="stuck" onOpen={work?.('stuck')} />
      </span>
    </li>
  );
}

export function ActivityView() {
  const tz = dayZone.value;
  const clock = dayClock.value; // moves at midnight (and at block boundaries): "today" follows
  const dayStart = dayRange(localDate(clock, tz), tz).from;
  const allowed = can('tasks.list');
  // Finished work of today: while it loads or after it failed no "Done today" is shown – never a false 0.
  const [doneState, setDoneState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!allowed) return undefined;
    let live = true;
    setDoneState('loading');
    ensureDone({ since: dayStart }).then(() => { if (live) setDoneState('ready'); }, () => { if (live) setDoneState('failed'); });
    return () => { live = false; };
  }, [allowed, dayStart, attempt]);
  const doneKnown = doneState === 'ready';
  const workScope = { keepOwn: isPersonSession() }; // as Work and Home
  const rows = activityRows(members(peopleTree.value), {
    open: tasks.value, todos: todos.value, done: doneTasks.value, live: activity.value, now: Date.now(), dayStart,
    counted: (task) => onWork(task, workScope),
  }).filter((row) => row.member.kind !== 'team' || row.open > 0 || row.doneToday > 0); // "No owner yet" only while there is such work
  const totals = activityTotals(rows);
  return (
    <div class="pane-view pane-scroll pane-activity">
      {!allowed && <EmptyState>Work is not shared with this device.</EmptyState>}
      {allowed && (
        <>
          <p class="activity-totals" aria-label="Today">
            {[doneKnown ? `${totals.doneToday} done today` : '', `${totals.working} working now`, `${totals.open} open`, `${totals.stuck} stuck`].filter(Boolean).join(' · ')}
          </p>
          {doneState === 'failed' && (
            <p class="activity-totals muted">Could not load finished work. <button type="button" class="text-button" onClick={() => setAttempt(attempt + 1)}>Retry</button></p>
          )}
          <ul class="activity-list">{rows.map((row) => <MemberRow key={`${row.member.kind}-${row.member.id}`} row={row} doneKnown={doneKnown} />)}</ul>
        </>
      )}
    </div>
  );
}
