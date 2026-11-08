// AF-017: the agent directory's pure rules – one entry per active agent with its project (AF-018: the project whose
// agents list it, i.e. its home folder), its team, its status in four words (Working, Waiting, Idle, Error) and what it
// does right now, who hired it and when, and whether it is "new" (hired by an agent in the last day and not opened
// since). Then the directory's search, its filters (all, running, new, without a project) and its grouping by
// project, team or status.
// Owns: these derivations (unit-tested in test/unit/ui/agent-directory.test.ts). Never: reads stores, calls the
// runtime or renders (AgentDirectory.tsx does).

import type { Agent, Space } from '../../shared/model/org.ts';
import type { AgentActivity } from '../../shared/model/runs.ts';

export type DirectoryStatus = 'working' | 'waiting' | 'idle' | 'error';
export type DirectoryFilter = 'all' | 'running' | 'new' | 'no-project';
export type DirectoryGrouping = 'project' | 'team' | 'status';

export const STATUS_LABELS: Record<DirectoryStatus, string> = { working: 'Working', waiting: 'Waiting', idle: 'Idle', error: 'Error' };
export const FILTER_LABELS: Record<DirectoryFilter, string> = { all: 'All', running: 'Running', new: 'New', 'no-project': 'No project' };
export const GROUPING_LABELS: Record<DirectoryGrouping, string> = { project: 'Project', team: 'Team', status: 'Status' };

/** How long an agent hired by another one counts as new (unless opened before). */
export const NEW_FOR_MS = 86_400_000;

const STATUS_ORDER: readonly DirectoryStatus[] = ['working', 'waiting', 'error', 'idle'];

export interface DirectoryProject { id: string; name: string }

export interface DirectoryEntry {
  agent: Agent;
  project?: DirectoryProject;
  /** The free-text team, else the agent's space, else ''. */
  team: string;
  status: DirectoryStatus;
  /** One line: the live note, the status note, else the role. */
  activity: string;
  /** "You", the hiring agent's name, or "Autark" for the app itself. */
  createdBy: string;
  isNew: boolean;
}

export interface DirectoryInput {
  agents: readonly Agent[];
  projects: ReadonlyArray<{ id: string; name: string; agents: ReadonlyArray<{ id: string }> }>;
  spaces?: readonly Space[];
  live?: ReadonlyMap<string, AgentActivity>;
  /** Names of every known agent (archived ones too), for "hired by". */
  nameOf: (id: string) => string | undefined;
  /** Agents the person opened already (their "new" mark is gone). */
  seen?: ReadonlySet<string>;
  now: number;
}

export function directoryStatus(agent: Pick<Agent, 'status'>, live: AgentActivity | undefined): DirectoryStatus {
  if (live || agent.status === 'working') return 'working';
  if (agent.status === 'waiting' || agent.status === 'paused') return 'waiting';
  if (agent.status === 'error') return 'error';
  return 'idle';
}

function activityLine(agent: Agent, live: AgentActivity | undefined): string {
  if (live?.note) return live.note;
  if (agent.statusNote && agent.status !== 'idle') return agent.statusNote;
  if (live) return 'Working';
  return agent.role;
}

export function creatorName(createdBy: string, nameOf: (id: string) => string | undefined): string {
  if (createdBy === 'human') return 'You';
  if (createdBy === 'system' || !createdBy) return 'Autark';
  return nameOf(createdBy) ?? 'an agent';
}

/** New: hired by an agent (not the person) within NEW_FOR_MS and not opened since. */
export function isNewAgent(agent: Pick<Agent, 'id' | 'createdBy' | 'createdAt'>, now: number, seen?: ReadonlySet<string>): boolean {
  if (agent.createdBy === 'human' || seen?.has(agent.id)) return false;
  return now - agent.createdAt >= 0 && now - agent.createdAt < NEW_FOR_MS;
}

/** The project an agent works in: the first project that lists it (the runtime's order: pinned, then activity). */
export function projectOf(agentId: string, projects: DirectoryInput['projects']): DirectoryProject | undefined {
  const project = projects.find((entry) => entry.agents.some((agent) => agent.id === agentId));
  return project ? { id: project.id, name: project.name } : undefined;
}

export function buildDirectory(input: DirectoryInput): DirectoryEntry[] {
  const spaceNames = new Map((input.spaces ?? []).filter((space) => !space.archivedAt).map((space) => [space.id, space.name]));
  return input.agents
    .filter((agent) => agent.archivedAt === undefined)
    .map((agent) => {
      const live = input.live?.get(agent.id);
      const project = projectOf(agent.id, input.projects);
      return {
        agent,
        ...(project ? { project } : {}),
        team: (agent.team ?? '').trim() || (agent.spaceId ? spaceNames.get(agent.spaceId) ?? '' : ''),
        status: directoryStatus(agent, live),
        activity: activityLine(agent, live),
        createdBy: creatorName(agent.createdBy, input.nameOf),
        isNew: isNewAgent(agent, input.now, input.seen),
      };
    })
    // new ones first, then those at work, then by name
    .sort((a, b) => Number(b.isNew) - Number(a.isNew)
      || STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
      || a.agent.name.localeCompare(b.agent.name, undefined, { sensitivity: 'base' }));
}

/** Search over name, role, team, project and what it does. */
export function matchesEntry(entry: DirectoryEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [entry.agent.name, entry.agent.role, entry.team, entry.project?.name ?? '', entry.activity, entry.createdBy]
    .some((text) => text.toLowerCase().includes(q));
}

export function passesFilter(entry: DirectoryEntry, filter: DirectoryFilter): boolean {
  switch (filter) {
    case 'running': return entry.status === 'working';
    case 'new': return entry.isNew;
    case 'no-project': return !entry.project;
    default: return true;
  }
}

export function filterDirectory(entries: readonly DirectoryEntry[], options: { query?: string; filter?: DirectoryFilter }): DirectoryEntry[] {
  const filter = options.filter ?? 'all';
  return entries.filter((entry) => passesFilter(entry, filter) && matchesEntry(entry, options.query ?? ''));
}

/** How many entries each filter would show (the filter chips' counts). */
export function filterCounts(entries: readonly DirectoryEntry[]): Record<DirectoryFilter, number> {
  const counts: Record<DirectoryFilter, number> = { all: 0, running: 0, new: 0, 'no-project': 0 };
  for (const entry of entries) for (const key of Object.keys(counts) as DirectoryFilter[]) if (passesFilter(entry, key)) counts[key]++;
  return counts;
}

export interface DirectoryGroup { key: string; label: string; entries: DirectoryEntry[] }

const NO_PROJECT = 'No project';
const NO_TEAM = 'No team';

/**
 * Groups keep the entries' order. By project: the projects by name, "No project" last. By team: the teams by name,
 * "No team" last. By status: Working, Waiting, Error, Idle (empty ones left out).
 */
export function groupDirectory(entries: readonly DirectoryEntry[], by: DirectoryGrouping): DirectoryGroup[] {
  const groups = new Map<string, DirectoryGroup>();
  const put = (key: string, label: string, entry: DirectoryEntry) => {
    const group = groups.get(key);
    if (group) group.entries.push(entry); else groups.set(key, { key, label, entries: [entry] });
  };
  for (const entry of entries) {
    if (by === 'project') put(entry.project ? `p:${entry.project.id}` : 'p:', entry.project?.name ?? NO_PROJECT, entry);
    else if (by === 'team') put(entry.team ? `t:${entry.team.toLowerCase()}` : 't:', entry.team || NO_TEAM, entry);
    else put(`s:${entry.status}`, STATUS_LABELS[entry.status], entry);
  }
  const list = [...groups.values()];
  if (by === 'status') return list.sort((a, b) => STATUS_ORDER.indexOf(a.entries[0].status) - STATUS_ORDER.indexOf(b.entries[0].status));
  const empty = by === 'project' ? 'p:' : 't:';
  return list.sort((a, b) => Number(a.key === empty) - Number(b.key === empty) || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}
