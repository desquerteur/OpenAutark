// Sidebar content for #/team (and the phone's Team tab): the one org chart. Header data (teamNavHeader –
// "Team", the in-place search and ONE fixed "Add" cell whose menu holds Agent, Person, Import an agent team… (set up with AI) and Start setup again).
// Body: People (the owner on top, people under whom they report to – each opens their page – with the agents
// that report to them) and the agents of the top grouped by space (space-less agents such as the Manager first
// without a heading, then one heading per space) and nested under their manager – a manager row (or a person
// with reports) expands its reports right below in a height-limited, internally scrolling block (most used
// first, other managers stay visible) – each agent with its real status ring/dot, one-line status and the tiny
// "AI". Right-click or long-press on a row opens its menu (menus.ts agentMenu / personMenu). B-057: an agent's
// splits are rows inside the same expansion, below its reports – a group that starts never pushes the open
// reports down (splits/SplitNav.tsx – the caret takes its reserved slot when the agent has only splits; a
// closed row shows the running count in its always-reserved cell). At the very end a collapsed "Archived (n)" group
// (ArchivedGroup.tsx; a right click on its rows offers Restore). AF-014: Add › "Agent from folder…" and a folder dropped on
// the list open FolderAgentDialog.tsx; Add › "Group agents by folder" shows the agents by home project (FolderGroups.tsx).
// Owns: the team navigation, its expand state (per device), search and the Add menu with its dialogs.
// Never: edits the org or draws header markup (lib/header.tsx does).

import { useEffect, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import type { Agent } from '../../shared/model/org.ts';
import type { Person } from '../../shared/model/people.ts';
import { AgentAvatar, Icon } from '../lib/ui.tsx';
import type { MenuSection } from '../lib/ui.tsx';
import type { HeaderProps } from '../lib/header.tsx';
import { useContextMenu, openContextMenu } from '../lib/context-menu.tsx';
import { agentName, agents, isMobile, route } from '../lib/store.ts';
import { go } from '../lib/router.ts';
import { can, isOwner } from '../lib/session.ts';
import { setupAgainAllowed, startSetupAgain } from '../onboarding/setup-again.ts';
import { countReports, groupBySpace, matchesAgent } from './model.ts';
import type { OrgEntry } from './model.ts';
import { countPersonReports, statusLabel } from './people-model.ts';
import type { PersonEntry } from './people-model.ts';
import { agentLine, AgentStatusAvatar, AiTag } from './parts.tsx';
import { ensureSpaces, orgTree, peopleTree, spaces, teamPeople } from './org-state.ts';
import { agentMenu, personMenu } from './menus.ts';
import { ArchivedGroup } from './ArchivedGroup.tsx';
import { NewAgentDialog } from './NewAgentDialog.tsx';
import { FolderGroups } from './FolderGroups.tsx'; // AF-014
import { droppedFolder, groupByFolder, mayHoldFolder, openFolderAgent, setGroupByFolder } from './folder-agent.ts'; // AF-014
import { PersonDialogs, personDialog } from './person-dialogs.tsx';
import { importTeamRequest, setUpWithAi } from './set-up-with-ai.ts';
import { SplitCount, SplitNavRows, hasSplits, useSplitNav } from '../splits/SplitNav.tsx'; // B-057

const EXPANDED_KEY = 'wf.teamExpanded';

/** The team search, shared by the header (field in the title's place) and the rows. */
const search = signal({ open: false, query: '' });

const addingAgent = signal(false);

/** The Add menu: Agent, Person (owner), Import an agent team… (the Manager's chat, prepared) and – apart – Start setup again. */
function addMenu(): MenuSection[] {
  const sections: MenuSection[] = [{ items: [
    { label: 'Agent', onSelect: () => { addingAgent.value = true; } },
    ...(isOwner() ? [{ label: 'Agent from folder…', onSelect: () => openFolderAgent() }] : []), // AF-014
    ...(can('people.save') ? [{ label: 'Person', onSelect: () => { personDialog.value = { kind: 'new' as const }; } }] : []),
    { label: 'Import an agent team…', onSelect: () => { void setUpWithAi(importTeamRequest()); } },
  ] }];
  if (isOwner()) sections.push({ items: [{ label: 'Group agents by folder', checked: groupByFolder.peek(), onSelect: () => setGroupByFolder(!groupByFolder.peek()) }] }); // AF-014
  if (setupAgainAllowed()) sections.push({ items: [{ label: 'Start setup again', onSelect: () => { void startSetupAgain(); } }] });
  return sections;
}

/** The Team side header: "Team", the fixed Add cell and the magnifier, whose field takes the title's place. */
export function teamNavHeader(): HeaderProps {
  const state = search.value;
  return {
    title: 'Team',
    cells: [{ id: 'add', icon: 'plus', label: 'Add', menu: addMenu() }],
    search: {
      label: 'Search the team', open: state.open, query: state.query,
      onQuery: (query) => { search.value = { ...search.peek(), query }; },
      onOpenChange: (open) => { search.value = { ...search.peek(), open }; },
    },
  };
}

function readExpanded(): string[] {
  try { return JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]') as string[]; } catch { return []; }
}

/** Managers above the open agent (agents, then the person they report to), so its row is visible without persisting that expansion. */
function ancestorsOf(agentId: string | undefined, list: Agent[], people: readonly Person[]): Set<string> {
  const out = new Set<string>();
  const byId = new Map(list.map((agent) => [agent.id, agent]));
  const personIds = new Set(people.map((person) => person.id));
  let current = agentId ? byId.get(agentId) : undefined;
  while (current?.managerId && !out.has(current.managerId)) {
    if (personIds.has(current.managerId)) { out.add(current.managerId); break; }
    if (!byId.has(current.managerId)) break;
    out.add(current.managerId);
    current = byId.get(current.managerId);
  }
  return out;
}

type Toggle = { expanded: boolean; onToggle: () => void } | null;

function Caret(props: { name: string; toggle: Toggle; what?: string }) {
  if (!props.toggle) return <span class="team-caret-space" aria-hidden="true" />;
  const { expanded, onToggle } = props.toggle;
  return (
    <button type="button" class="team-caret" aria-expanded={expanded} aria-label={`${expanded ? 'Hide' : 'Show'} ${props.what ?? 'reports'} of ${props.name}`} onClick={onToggle}>
      <Icon name={expanded ? 'caret-down' : 'caret-right'} size={12} />
    </button>
  );
}

function AgentRow(props: { agent: Agent; depth: number; reports: number; toggle?: Toggle; activeId?: string; what?: string }) {
  const { agent } = props;
  const active = agent.id === props.activeId;
  const toggle = props.toggle ?? null;
  const menu = useContextMenu(() => agentMenu(agent));
  return (
    <div class={`team-row${active ? ' active' : ''}`} style={{ '--depth': String(props.depth) }} {...menu}>
      <Caret name={agent.name} toggle={toggle} what={props.what} />
      <button type="button" class="team-row-open" aria-current={active ? 'page' : undefined} onClick={() => go.agent(agent.id)}>
        <AgentStatusAvatar agent={agent} size={30} />
        <span class="team-row-text">
          <span class="team-row-name"><span class="row-title">{agent.name}</span><AiTag /></span>
          <span class="row-preview">{agentLine(agent)}</span>
        </span>
        {toggle && !toggle.expanded && props.reports > 0 && <span class="nav-count tabular" title={`${props.reports} reports`}>{props.reports}</span>}
        <SplitCount agentId={agent.id} shown={!toggle?.expanded} />
      </button>
    </div>
  );
}

function PersonRow(props: { person: Person; depth: number; reports: number; toggle?: Toggle; activeId?: string }) {
  const { person } = props;
  const active = person.id === props.activeId;
  const toggle = props.toggle ?? null;
  const name = person.id === 'human' ? agentName('human') : person.name;
  const status = statusLabel(person);
  const line = [person.title, status === 'Active' || person.owner ? '' : status].filter(Boolean).join(' · ');
  const menu = useContextMenu(() => personMenu(person));
  return (
    <div class={`team-row person${active ? ' active' : ''}`} style={{ '--depth': String(props.depth) }} {...menu}>
      <Caret name={name} toggle={toggle} />
      <button type="button" class="team-row-open" aria-current={active ? 'page' : undefined} onClick={() => go.person(person.id)}>
        <AgentAvatar agentId={person.id} size={30} />
        <span class="team-row-text">
          <span class="row-title">{name}</span>
          {line && <span class="row-preview">{line}</span>}
        </span>
        {toggle && !toggle.expanded && <span class="nav-count tabular" title={`${props.reports} reports`}>{props.reports}</span>}
      </button>
    </div>
  );
}

interface Expand { expanded: Set<string>; toggle: (id: string) => void; activeId?: string; splitId?: string }

function Branch(props: { entry: OrgEntry; depth: number; expand: Expand }) {
  const { entry, expand } = props;
  const open = expand.expanded.has(entry.agent.id);
  const hasReports = entry.reports.length > 0;
  const splits = hasSplits(entry.agent.id); // B-057: the same expansion shows its split rows (never opened by itself)
  return (
    <>
      <AgentRow agent={entry.agent} depth={props.depth} reports={countReports(entry)} activeId={expand.splitId && splits && open ? undefined : expand.activeId}
        what={hasReports ? (splits ? 'reports and splits' : 'reports') : 'splits'}
        toggle={hasReports || splits ? { expanded: open, onToggle: () => expand.toggle(entry.agent.id) } : null} />
      {hasReports && open && (
        <div class={`team-reports${props.depth === 0 ? ' limited' : ''}`} role="group" aria-label={`Reports of ${entry.agent.name}`}>
          {entry.reports.map((report) => <Branch key={report.agent.id} entry={report} depth={props.depth + 1} expand={expand} />)}
        </div>
      )}
      {splits && open && <SplitNavRows agentId={entry.agent.id} depth={props.depth + 1} activeSplitId={expand.splitId} />}
    </>
  );
}

function PersonBranch(props: { entry: PersonEntry; depth: number; expand: Expand; personId?: string }) {
  const { entry, expand } = props;
  const id = entry.person.id;
  const reports = entry.people.length + entry.agents.length;
  const open = expand.expanded.has(id);
  return (
    <>
      <PersonRow person={entry.person} depth={props.depth} reports={countPersonReports(entry)} activeId={props.personId}
        toggle={reports ? { expanded: open, onToggle: () => expand.toggle(id) } : null} />
      {reports > 0 && open && (
        <div class="team-reports" role="group" aria-label={`Reports of ${entry.person.name}`}>
          {entry.people.map((report) => <PersonBranch key={report.person.id} entry={report} depth={props.depth + 1} expand={expand} personId={props.personId} />)}
          {entry.agents.map((report) => <Branch key={report.agent.id} entry={report} depth={props.depth + 1} expand={expand} />)}
        </div>
      )}
    </>
  );
}

function matchesPerson(person: Person, query: string): boolean {
  const q = query.trim().toLowerCase();
  return person.name.toLowerCase().includes(q) || person.title.toLowerCase().includes(q);
}

export function TeamNav() {
  const query = search.value.query;
  const [stored, setStored] = useState<string[]>(readExpanded);
  useEffect(() => { ensureSpaces(); }, []);
  useEffect(() => () => { search.value = { open: false, query: '' }; }, []); // shown again: no search
  useSplitNav(); // B-057: the agents' newest split groups

  const current = route.value.view === 'team' ? route.value : undefined;
  const activeId = current?.agentId;
  const personId = current?.personId;
  const list = agents.value.filter((agent) => !agent.archivedAt);
  const [collapsed, setCollapsed] = useState<string[]>([]); // closed by hand this session (wins over auto-open)
  const auto = [...ancestorsOf(activeId, list, teamPeople.value)];
  const expanded = new Set([...stored, ...auto].filter((id) => !collapsed.includes(id)));
  const toggle = (id: string) => {
    const open = expanded.has(id);
    const next = open ? stored.filter((entry) => entry !== id) : [...stored.filter((entry) => entry !== id), id];
    setStored(next);
    setCollapsed(open ? [...collapsed, id] : collapsed.filter((entry) => entry !== id));
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };
  const expand: Expand = { expanded, toggle, activeId, splitId: current?.splitId };
  const groups = groupBySpace(orgTree.value, spaces.value);
  const q = query.trim();
  const agentMatches = q ? list.filter((agent) => matchesAgent(agent, q)).sort((a, b) => a.name.localeCompare(b.name)) : [];
  const personMatches = q ? teamPeople.value.filter((person) => matchesPerson(person, q)).sort((a, b) => a.name.localeCompare(b.name)) : [];

  return (
    <div class="team-nav" // AF-014: a folder dropped here opens "Agent from folder"
      onDragOver={(event) => { if (isOwner() && mayHoldFolder(event.dataTransfer)) event.preventDefault(); }}
      onDrop={(event) => { const folder = isOwner() ? droppedFolder(event.dataTransfer) : undefined; if (folder) { event.preventDefault(); openFolderAgent(folder); } }}>
      {isMobile.value && ( // the phone has no side header: its Add sits at the top of the list
        <button type="button" class="text-button team-add" aria-haspopup="menu" onClick={(event) => { const box = (event.currentTarget as HTMLElement).getBoundingClientRect(); openContextMenu(box.left, box.bottom, addMenu()); }}>Add</button>
      )}
      <div class="team-rows">
        {q
          ? (agentMatches.length || personMatches.length
            ? (
              <>
                {personMatches.map((person) => <PersonRow key={person.id} person={person} depth={0} reports={0} activeId={personId} />)}
                {agentMatches.map((agent) => <AgentRow key={agent.id} agent={agent} depth={0} reports={0} activeId={activeId} />)}
              </>
            )
            : <p class="empty-state team-empty">Nobody found</p>)
          : (
            <>
              {peopleTree.value.length > 0 && (
                <div class="team-space team-people">
                  <div class="team-space-title">People</div>
                  {peopleTree.value.map((entry) => <PersonBranch key={entry.person.id} entry={entry} depth={0} expand={expand} personId={personId} />)}
                </div>
              )}
              {groupByFolder.value ? <FolderGroups agents={list} row={(agent) => <AgentRow key={agent.id} agent={agent} depth={0} reports={0} activeId={activeId} />} /> : groups.map((group, index) => (
                <div class="team-space" key={group.space?.id ?? `rest-${index}`}>
                  {(group.space || peopleTree.value.length > 0) && <div class="team-space-title">{group.space?.name ?? 'Agents'}</div>}
                  {group.entries.map((entry) => <Branch key={entry.agent.id} entry={entry} depth={0} expand={expand} />)}
                </div>
              ))}
            </>
          )}
        {!q && !list.length && <p class="empty-state team-empty">No agents yet</p>}
        {!q && <ArchivedGroup />}
      </div>
      <NewAgentDialog open={addingAgent.value} onClose={() => { addingAgent.value = false; }} />
      <PersonDialogs />
    </div>
  );
}
