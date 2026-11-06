// Sidebar of Work (#/tasks, B-078 D10): its header data (taskFiltersHeader – the destination's name, drawn by the
// frame's side header row, shell/views.ts) and "People & agents" – every agent and person with open work, most
// first, with its avatar (people round, agents rounded-square – lib/avatar.tsx) and count; a click narrows Work to
// them (#/tasks?owner=: their open work as slim rows), a second click shows Work's For you and report again – and
// "Unassigned" while work has no owner. Every click closes an open task detail (the route loses its ?task=). The
// views All work · Stuck · Done are gone: Work shows only what needs the person and the team's report.
// Owns: these rows and where they lead. Never: loads task data (TasksView does), groups work
// itself (tasks/work-model.ts) or draws header markup (lib/header.tsx does).

import type { ComponentChildren } from 'preact';
import { agentName, route, tasks } from '../lib/store.ts';
import { navigate } from '../lib/router.ts';
import { isPersonSession } from '../lib/people.ts';
import { DESTINATIONS } from '../lib/vocab.ts';
import { AgentAvatar, Icon } from '../lib/ui.tsx';
import type { HeaderProps } from '../lib/header.tsx';
import { workOwners, workRoute } from '../tasks/work-model.ts';
import type { WorkOwner } from '../tasks/work-model.ts';

function OwnerRow(props: { label: string; count: number; current: boolean; onPick: () => void; avatar: ComponentChildren }) {
  return (
    <button type="button" class="nav-row work-owner-row" aria-pressed={props.current}
      title={props.current ? 'Show everyone\'s work' : undefined} onClick={props.onPick}>
      {props.avatar}
      <span class="work-owner-name">{props.label}</span>
      {props.count > 0 && <span class="nav-count tabular">{props.count}</span>}
    </button>
  );
}

/** The Work side header: the destination's name. */
export function taskFiltersHeader(): HeaderProps {
  return { title: DESTINATIONS.tasks };
}

export function TaskFiltersNav() {
  const current = route.value.view === 'tasks' ? route.value : undefined;
  const owner = current?.owner;
  const scope = { keepOwn: isPersonSession() };
  const { owners, unassigned } = workOwners(tasks.value, agentName, scope);
  // The chosen owner stays listed while its work is gone (count 0), so a second click can clear it.
  const listed: WorkOwner[] = owner && owner !== 'team' && !owners.some((entry) => entry.id === owner)
    ? [...owners, { id: owner, kind: 'agent', count: 0 }] : owners;
  const pick = (id: string) => navigate(workRoute(owner === id ? undefined : id));
  return (
    <div class="sidebar-section">
      <nav class="nav-list" aria-label="Work">
        <button type="button" class="nav-row" aria-current={current && !owner ? 'page' : undefined} onClick={() => navigate(workRoute())}>
          <span>For you &amp; report</span>
        </button>
      </nav>
      {(listed.length > 0 || unassigned > 0 || owner === 'team') && (
        <nav class="nav-list work-owners" aria-label="People & agents">
          <h3 class="panel-heading">People &amp; agents</h3>
          {listed.map((entry) => (
            <OwnerRow key={entry.id} label={agentName(entry.id)} count={entry.count} current={owner === entry.id}
              avatar={<AgentAvatar agentId={entry.id} size={22} />} onPick={() => pick(entry.id)} />
          ))}
          {(unassigned > 0 || owner === 'team') && (
            <OwnerRow label="Unassigned" count={unassigned} current={owner === 'team'}
              avatar={<span class="work-owner-icon" aria-hidden="true"><Icon name="users-three" size={14} /></span>} onPick={() => pick('team')} />
          )}
        </nav>
      )}
    </div>
  );
}
