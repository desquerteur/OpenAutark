// AF-017: the agent directory's rules (src/ui/agents/directory-model.ts) – status, "new", project and team per agent,
// search, the filters (running, new, without a project) and the grouping by project, team and status; the chat
// header's line for an agent (agent-chat-line.ts) and the palette's agent entries (shell/palette-agents.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, Space } from '../../../src/shared/model/org.ts';
import type { AgentActivity } from '../../../src/shared/model/runs.ts';
import {
  NEW_FOR_MS, buildDirectory, creatorName, directoryStatus, filterCounts, filterDirectory, groupDirectory, isNewAgent, projectOf,
} from '../../../src/ui/agents/directory-model.ts';
import { agentChatLine } from '../../../src/ui/agents/agent-chat-line.ts';
import { agentPaletteEntries } from '../../../src/ui/shell/palette-agents.ts';

const NOW = Date.UTC(2026, 10, 8, 12);
const HOUR = 3_600_000;

function agent(id: string, patch: Partial<Agent> = {}): Agent {
  return {
    id, name: patch.name ?? id, role: 'Role', avatar: { kind: 'initials', value: id.slice(0, 2) }, instructions: '', mode: 'general',
    skills: [], modelPolicy: {}, status: 'idle', createdBy: 'human', createdAt: NOW - 30 * 24 * HOUR, updatedAt: 0,
    ...patch,
  };
}

function live(agentId: string, note = ''): AgentActivity {
  return { agentId, runId: `run-${agentId}`, note, startedAt: NOW - 1000 };
}

const SPACES: Space[] = [{ id: 'sp1', name: 'Company', kind: 'company', sort: 0, createdAt: 0 }];

const manager = agent('mgr', { name: 'Manager', role: 'Runs the team' });
const making = agent('mk', { name: 'Making', role: 'Builds prototypes', createdBy: 'mgr', createdAt: NOW - 2 * HOUR, team: 'Product' });
const vera = agent('ve', { name: 'Vera', role: 'Video editor', spaceId: 'sp1', status: 'waiting', statusNote: 'waits for the logo' });
const old = agent('old', { name: 'Old', archivedAt: NOW - HOUR });
const PROJECTS = [
  { id: 'p-autark', name: 'Autark', agents: [{ id: 'mk' }] },
  { id: 'p-site', name: 'Site', agents: [{ id: 'mk' }, { id: 've' }] },
];

function entries(extra: { seen?: Set<string>; live?: Map<string, AgentActivity> } = {}) {
  return buildDirectory({
    agents: [manager, making, vera, old], projects: PROJECTS, spaces: SPACES, live: extra.live, seen: extra.seen,
    nameOf: (id) => [manager, making, vera, old].find((entry) => entry.id === id)?.name, now: NOW,
  });
}

test('status: a live run is Working, waiting and paused are Waiting, error is Error, the rest Idle', () => {
  assert.equal(directoryStatus({ status: 'idle' }, live('a')), 'working');
  assert.equal(directoryStatus({ status: 'working' }, undefined), 'working');
  assert.equal(directoryStatus({ status: 'paused' }, undefined), 'waiting');
  assert.equal(directoryStatus({ status: 'waiting' }, undefined), 'waiting');
  assert.equal(directoryStatus({ status: 'error' }, undefined), 'error');
  assert.equal(directoryStatus({ status: 'idle' }, undefined), 'idle');
});

test('new: hired by an agent within a day and not opened since; never a hire by the person', () => {
  assert.equal(isNewAgent(making, NOW), true);
  assert.equal(isNewAgent(making, NOW, new Set(['mk'])), false);
  assert.equal(isNewAgent(making, making.createdAt + NEW_FOR_MS), false);
  assert.equal(isNewAgent({ ...making, createdBy: 'human' }, NOW), false);
});

test('creator: You for the person, the agent by name, Autark for the system', () => {
  const nameOf = (id: string) => (id === 'mgr' ? 'Manager' : undefined);
  assert.equal(creatorName('human', nameOf), 'You');
  assert.equal(creatorName('mgr', nameOf), 'Manager');
  assert.equal(creatorName('system', nameOf), 'Autark');
  assert.equal(creatorName('gone', nameOf), 'an agent');
});

test('the project is the first project that lists the agent', () => {
  assert.deepEqual(projectOf('mk', PROJECTS), { id: 'p-autark', name: 'Autark' });
  assert.deepEqual(projectOf('ve', PROJECTS), { id: 'p-site', name: 'Site' });
  assert.equal(projectOf('mgr', PROJECTS), undefined);
});

test('entries: archived agents left out, new first, then at work, then by name; team falls back to the space', () => {
  const list = entries({ live: new Map([['mgr', live('mgr', 'planning the week')]]) });
  assert.deepEqual(list.map((entry) => entry.agent.id), ['mk', 'mgr', 've']);
  const [mk, mgr, ve] = list;
  assert.equal(mk.isNew, true);
  assert.equal(mk.createdBy, 'Manager');
  assert.equal(mk.team, 'Product');
  assert.equal(mk.project?.name, 'Autark');
  assert.equal(mgr.status, 'working');
  assert.equal(mgr.activity, 'planning the week');
  assert.equal(mgr.project, undefined);
  assert.equal(ve.team, 'Company');
  assert.equal(ve.status, 'waiting');
  assert.equal(ve.activity, 'waits for the logo');
});

test('filters: running, new and without a project, with their counts', () => {
  const list = entries({ live: new Map([['mgr', live('mgr')]]) });
  assert.deepEqual(filterDirectory(list, { filter: 'running' }).map((entry) => entry.agent.id), ['mgr']);
  assert.deepEqual(filterDirectory(list, { filter: 'new' }).map((entry) => entry.agent.id), ['mk']);
  assert.deepEqual(filterDirectory(list, { filter: 'no-project' }).map((entry) => entry.agent.id), ['mgr']);
  assert.deepEqual(filterCounts(list), { all: 3, running: 1, new: 1, 'no-project': 1 });
  assert.equal(filterCounts(entries({ seen: new Set(['mk']) })).new, 0);
});

test('search matches name, role, team, project and who hired it', () => {
  const list = entries();
  const ids = (query: string) => filterDirectory(list, { query }).map((entry) => entry.agent.id);
  assert.deepEqual(ids('mak'), ['mk']);
  assert.deepEqual(ids('video'), ['ve']);
  assert.deepEqual(ids('autark'), ['mk']);
  assert.deepEqual(ids('product'), ['mk']);
  assert.deepEqual(ids('manager'), ['mk', 'mgr']); // Making was hired by the Manager
  assert.deepEqual(filterDirectory(list, { query: 'site', filter: 'new' }), []);
});

test('grouping by project: projects by name, "No project" last', () => {
  const groups = groupDirectory(entries(), 'project');
  assert.deepEqual(groups.map((group) => [group.label, group.entries.map((entry) => entry.agent.id)]), [
    ['Autark', ['mk']], ['Site', ['ve']], ['No project', ['mgr']],
  ]);
});

test('grouping by team: teams by name (case-insensitive key), "No team" last', () => {
  const lower = agent('lo', { name: 'Lou', team: 'product' });
  const list = buildDirectory({ agents: [manager, making, vera, lower], projects: [], spaces: SPACES, nameOf: () => undefined, now: NOW });
  assert.deepEqual(groupDirectory(list, 'team').map((group) => [group.label, group.entries.length]), [['Company', 1], ['Product', 2], ['No team', 1]]);
});

test('grouping by status: Working, Waiting, Error, Idle – empty ones left out', () => {
  const broken = agent('br', { name: 'Bruno', status: 'error' });
  const list = buildDirectory({ agents: [manager, vera, broken], projects: [], live: new Map([['mgr', live('mgr')]]), nameOf: () => undefined, now: NOW });
  assert.deepEqual(groupDirectory(list, 'status').map((group) => group.label), ['Working', 'Waiting', 'Error']);
});

test('the agent chat header line names role, project (unless the chip shows it) and who hired it', () => {
  assert.equal(agentChatLine({ role: 'Builds prototypes', project: 'Autark', chipShown: false, hiredBy: 'Manager' }), 'Builds prototypes · Project Autark · hired by Manager');
  assert.equal(agentChatLine({ role: 'Builds prototypes', project: 'Autark', chipShown: true, hiredBy: 'Manager' }), 'Builds prototypes · hired by Manager');
  assert.equal(agentChatLine({ role: 'Assistant', chipShown: false, hiredBy: 'You' }), 'Assistant · No project · hired by you');
});

test('palette: per active agent its page (role · project) and, where allowed, its chat', () => {
  const list = agentPaletteEntries([manager, making, old], PROJECTS, { canChat: (id) => id !== 'mgr' });
  assert.deepEqual(list.map((entry) => [entry.kind, entry.label, entry.hint]), [
    ['page', 'Manager', 'Runs the team'],
    ['page', 'Making', 'Builds prototypes · Autark'],
    ['chat', 'Chat with Making', 'Open chat'],
  ]);
});
