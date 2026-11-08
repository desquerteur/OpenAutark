// AF-017: the agent directory – the ONE place that lists every agent (data-tour="agent-directory"). It is the main
// page of #/team (the org chart stays in the sidebar, TeamNav.tsx) and on the phone a tab of Team. Per agent one row:
// avatar with its real status, name (a "New" mark for a fresh hire by an agent), role, project (AF-018) or "No
// project", status and what it does right now, who hired it and when, and the direct actions Open chat, Agent page
// and Show in project. Search, the filters All / Running / New / No project (with counts) and grouping by project,
// team or status – both remembered per device.
// Owns: the directory's markup and its view choices. Never: its rules (directory-model.ts) or a second agent list.

import { useEffect, useState } from 'preact/hooks';
import { Button, Icon } from '../lib/ui.tsx';
import { dayMonth, fullDate } from '../lib/format.ts';
import { AgentStatusAvatar, AiTag } from '../team/parts.tsx';
import { useContextMenu } from '../lib/context-menu.tsx';
import { agentMenu } from '../team/menus.ts';
import {
  FILTER_LABELS, GROUPING_LABELS, STATUS_LABELS, filterCounts, filterDirectory, groupDirectory,
  type DirectoryEntry, type DirectoryFilter, type DirectoryGrouping,
} from './directory-model.ts';
import { directoryEntries, openAgentChat, openAgentPage, showInProject, tickDirectory, watchDirectory } from './directory-state.ts';

const VIEW_KEY = 'wf.agentDirectory';
const FILTERS: readonly DirectoryFilter[] = ['all', 'running', 'new', 'no-project'];
const GROUPINGS: readonly DirectoryGrouping[] = ['project', 'team', 'status'];

interface ViewChoice { filter: DirectoryFilter; grouping: DirectoryGrouping }

function readView(): ViewChoice {
  try {
    const stored = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Partial<ViewChoice>;
    return {
      filter: FILTERS.includes(stored.filter as DirectoryFilter) ? stored.filter as DirectoryFilter : 'all',
      grouping: GROUPINGS.includes(stored.grouping as DirectoryGrouping) ? stored.grouping as DirectoryGrouping : 'project',
    };
  } catch { return { filter: 'all', grouping: 'project' }; }
}

function DirectoryRow(props: { entry: DirectoryEntry }) {
  const { entry } = props;
  const { agent } = entry;
  const menu = useContextMenu(() => agentMenu(agent));
  return (
    <li class={`directory-row status-${entry.status}${entry.isNew ? ' is-new' : ''}`} data-agent-id={agent.id} {...menu}>
      <AgentStatusAvatar agent={agent} size={36} onClick={() => openAgentPage(agent.id)} />
      <div class="directory-main">
        <div class="directory-name-line">
          <a class="directory-name" href={`#/team/${encodeURIComponent(agent.id)}`} onClick={(event) => { event.preventDefault(); openAgentPage(agent.id); }}>{agent.name}</a>
          <AiTag />
          {entry.isNew && <span class="directory-new">New</span>}
        </div>
        <div class="directory-role" title={agent.role}>{agent.role}</div>
        <div class="directory-now">
          <span class={`directory-status status-${entry.status}`}>{STATUS_LABELS[entry.status]}</span>
          {entry.activity && entry.activity !== agent.role && <span class="directory-activity" title={entry.activity}>{entry.activity}</span>}
        </div>
      </div>
      <div class="directory-meta">
        {entry.project
          ? <button type="button" class="directory-project" title={`Show ${agent.name} in ${entry.project.name}`} onClick={() => showInProject(entry.project!.id)}><Icon name="folder" size={12} /><span>{entry.project.name}</span></button>
          : <span class="directory-project none"><Icon name="folder" size={12} /><span>No project</span></span>}
        {entry.team && <span class="directory-team" title="Team">{entry.team}</span>}
        <span class="directory-hired" title={fullDate(agent.createdAt)}>Hired by {entry.createdBy} · {dayMonth(agent.createdAt)}</span>
      </div>
      <div class="directory-actions">
        <Button variant="primary" class="small" icon="chat-circle" onClick={() => openAgentChat(agent.id)}>Open chat</Button>
        <Button variant="secondary" class="small" onClick={() => openAgentPage(agent.id)}>Agent page</Button>
        {entry.project && <Button variant="ghost" class="small" onClick={() => showInProject(entry.project!.id)}>Show in project</Button>}
      </div>
    </li>
  );
}

export function AgentDirectory() {
  const [view, setView] = useState<ViewChoice>(readView);
  const [query, setQuery] = useState('');
  useEffect(() => { watchDirectory(); tickDirectory(); }, []);
  const choose = (next: Partial<ViewChoice>) => {
    const value = { ...view, ...next };
    setView(value);
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(value)); } catch { /* ignore */ }
  };
  const entries = directoryEntries.value;
  const counts = filterCounts(entries);
  const shown = filterDirectory(entries, { query, filter: view.filter });
  const groups = groupDirectory(shown, view.grouping);
  return (
    <div class="agent-directory" data-tour="agent-directory">
      <div class="directory-head">
        <div class="directory-title-line">
          <h3 class="directory-title">All agents</h3>
          <span class="directory-total tabular">{entries.length}</span>
        </div>
        <p class="directory-lead">Every agent in one place – where it works, what it does now and who hired it.</p>
        <div class="directory-tools">
          <label class="directory-search">
            <Icon name="magnifying-glass" size={14} />
            <input type="search" placeholder="Find an agent, a role or a project" aria-label="Find an agent" value={query}
              onInput={(event) => setQuery((event.target as HTMLInputElement).value)} />
          </label>
          <div class="directory-filters" role="group" aria-label="Show">
            {FILTERS.map((filter) => (
              <button key={filter} type="button" class="directory-chip" aria-pressed={view.filter === filter} onClick={() => choose({ filter })}>
                {FILTER_LABELS[filter]}<span class="tabular">{counts[filter]}</span>
              </button>
            ))}
          </div>
          <div class="directory-grouping" role="group" aria-label="Group by">
            <span class="directory-grouping-label">Group by</span>
            {GROUPINGS.map((grouping) => (
              <button key={grouping} type="button" class="directory-seg" aria-pressed={view.grouping === grouping} onClick={() => choose({ grouping })}>{GROUPING_LABELS[grouping]}</button>
            ))}
          </div>
        </div>
      </div>
      {groups.length
        ? groups.map((group) => (
          <section class="directory-group" key={group.key} aria-label={group.label}>
            <h4 class="directory-group-title">{group.label}<span class="tabular">{group.entries.length}</span></h4>
            <ul class="directory-list">{group.entries.map((entry) => <DirectoryRow key={entry.agent.id} entry={entry} />)}</ul>
          </section>
        ))
        : <p class="empty-state directory-empty">{entries.length ? 'No agent matches.' : 'No agents yet.'}</p>}
    </div>
  );
}
