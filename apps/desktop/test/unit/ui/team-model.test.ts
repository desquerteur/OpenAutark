// Pure team view helpers (src/ui/team/model.ts): org tree with cycle safety and "most used" ranking, grouping by
// space, status lines, search, the archived list and run item pairing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, Space } from '../../../src/shared/model/org.ts';
import type { Member } from '../../../src/shared/model/chat.ts';
import type { ConversationSummary } from '../../../src/shared/model/chat.ts';
import type { RunItem } from '../../../src/shared/model/runs.ts';
import type { OrgEntry } from '../../../src/ui/team/model.ts';
import {
  agentStatusLine, applyArchived, buildOrg, countReports, effectiveStatus, groupBySpace, interactionScores, matchesAgent, previewData, runEntries,
} from '../../../src/ui/team/model.ts';

const NOW = Date.UTC(2026, 9, 18, 12);
const DAY = 86_400_000;

function agent(id: string, patch: Partial<Agent> = {}): Agent {
  return {
    id, name: patch.name ?? id.toUpperCase(), role: 'Role', avatar: { kind: 'initials', value: id.slice(0, 2) }, instructions: '', mode: 'general',
    skills: [], modelPolicy: {}, status: 'idle', createdBy: 'human', createdAt: 0, updatedAt: 0,
    ...patch,
  };
}

function member(memberId: string, kind: Member['kind']): Member {
  return { conversationId: 'c', memberId, kind, role: 'member', readSeq: 0, joinedAt: 0 };
}

function chat(members: Member[], lastMessageAt: number): Pick<ConversationSummary, 'members' | 'lastMessageAt' | 'createdAt'> {
  return { members, lastMessageAt, createdAt: 0 };
}

test('interactionScores: only chats with the human count, recent chats weigh more', () => {
  const scores = interactionScores([
    chat([member('human', 'human'), member('a', 'agent')], NOW),
    chat([member('human', 'human'), member('b', 'agent')], NOW - 60 * DAY),
    chat([member('a', 'agent'), member('c', 'agent')], NOW), // agent-only room: ignored
    chat([member('human', 'human'), { ...member('c', 'agent'), leftAt: 1 }], NOW), // left: ignored
  ], NOW);
  assert.ok((scores.get('a') ?? 0) > (scores.get('b') ?? 0));
  assert.ok((scores.get('b') ?? 0) > 0);
  assert.equal(scores.get('c'), undefined);
});

test('buildOrg nests reports, ranks siblings by score and survives cycles and archived managers', () => {
  const agents = [
    agent('m', { name: 'Manager' }),
    agent('x', { name: 'Xena', managerId: 'm' }),
    agent('y', { name: 'Yuri', managerId: 'm' }),
    agent('z', { name: 'Zed', managerId: 'gone' }), // manager missing → root
    agent('p', { name: 'P', managerId: 'q' }), // p ↔ q cycle
    agent('q', { name: 'Q', managerId: 'p' }),
    agent('old', { name: 'Old', archivedAt: 1 }),
    agent('r', { name: 'R', managerId: 'old' }), // archived manager → root
  ];
  const tree = buildOrg(agents, new Map([['y', 5]]));
  const roots = tree.map((entry) => entry.agent.id);
  assert.ok(roots.includes('m') && roots.includes('z') && roots.includes('r'));
  assert.ok(!roots.includes('old'));
  const manager = tree.find((entry) => entry.agent.id === 'm')!;
  assert.deepEqual(manager.reports.map((entry) => entry.agent.id), ['y', 'x']); // score first
  assert.equal(countReports(manager), 2);
  // Every active agent appears exactly once.
  const seen: string[] = [];
  const walk = (entries: typeof tree) => { for (const entry of entries) { seen.push(entry.agent.id); walk(entry.reports); } };
  walk(tree);
  assert.deepEqual(seen.slice().sort(), ['m', 'p', 'q', 'r', 'x', 'y', 'z']);
});

test('groupBySpace: space-less roots first without a heading, then one group per active space in order', () => {
  const spaces: Space[] = [
    { id: 'sp_b', name: 'Brand', kind: 'brand', sort: 2, createdAt: 0 },
    { id: 'sp_a', name: 'Company', kind: 'company', sort: 1, createdAt: 0 },
    { id: 'sp_old', name: 'Old', kind: 'custom', sort: 0, createdAt: 0, archivedAt: 1 },
  ];
  const tree = buildOrg([agent('a', { spaceId: 'sp_a' }), agent('b', { spaceId: 'sp_b' }), agent('c'), agent('d', { spaceId: 'sp_old' })]);
  const groups = groupBySpace(tree, spaces);
  assert.deepEqual(groups.map((group) => group.space?.id ?? null), [null, 'sp_a', 'sp_b']);
  assert.deepEqual(groups[0].entries.map((entry) => entry.agent.id).sort(), ['c', 'd'], 'archived space = no space');
  assert.deepEqual(groupBySpace(buildOrg([agent('m')]), []).map((group) => [group.space, group.entries.length]), [[undefined, 1]]);
  assert.deepEqual(groupBySpace([], spaces), []);
});

test('groupBySpace: area agents hired by the space-less Manager show under their area, branches stay together', () => {
  const spaces: Space[] = [
    { id: 'sp_priv', name: 'Private', kind: 'private', sort: 0, createdAt: 0 },
    { id: 'sp_brand', name: 'Personal brand', kind: 'brand', sort: 1, createdAt: 0 },
  ];
  const tree = buildOrg([
    agent('m', { name: 'Manager' }),
    agent('sec', { name: 'Secretary', managerId: 'm', spaceId: 'sp_priv' }),
    agent('ed', { name: 'Editor', managerId: 'm', spaceId: 'sp_brand' }),
    agent('cut', { name: 'Cutter', managerId: 'ed', spaceId: 'sp_brand' }), // same space: stays nested
    agent('help', { name: 'Helper', managerId: 'ed' }), // no space: stays in the branch
    agent('ops', { name: 'Ops', managerId: 'm' }), // no space: stays under the Manager
    agent('own', { name: 'Own', spaceId: 'sp_brand' }), // a root of the space comes first
  ]);
  const groups = groupBySpace(tree, spaces);
  assert.deepEqual(groups.map((group) => group.space?.name ?? null), [null, 'Private', 'Personal brand']);
  assert.deepEqual(groups[0].entries.map((entry) => entry.agent.id), ['m']);
  assert.deepEqual(groups[0].entries[0].reports.map((entry) => entry.agent.id), ['ops']);
  assert.equal(countReports(groups[0].entries[0]), 1, 'counts follow what is shown');
  assert.deepEqual(groups[1].entries.map((entry) => entry.agent.id), ['sec']);
  assert.deepEqual(groups[2].entries.map((entry) => entry.agent.id), ['own', 'ed']);
  assert.deepEqual(groups[2].entries[1].reports.map((entry) => entry.agent.id).sort(), ['cut', 'help']);
  // Archiving the Private space only removes its heading: the secretary goes back under the Manager.
  const archived = groupBySpace(tree, [{ ...spaces[0], archivedAt: 1 }, spaces[1]]);
  assert.deepEqual(archived.map((group) => group.space?.name ?? null), [null, 'Personal brand']);
  assert.deepEqual(archived[0].entries[0].reports.map((entry) => entry.agent.id).sort(), ['ops', 'sec']);
  // Every agent appears exactly once.
  const seen: string[] = [];
  const walk = (entries: typeof tree) => { for (const entry of entries) { seen.push(entry.agent.id); walk(entry.reports); } };
  for (const group of groups) walk(group.entries);
  assert.deepEqual(seen.sort(), ['cut', 'ed', 'help', 'm', 'ops', 'own', 'sec']);
});

test('groupBySpace: a space-less area manager moves into its team\'s area; branches never split', () => {
  const spaces: Space[] = [
    { id: 'sp_brand', name: 'Personal brand', kind: 'brand', sort: 0, createdAt: 0 },
    { id: 'sp_co', name: 'Company', kind: 'company', sort: 1, createdAt: 0 },
  ];
  const ids = (entries: OrgEntry[]) => entries.map((entry) => entry.agent.id);
  // Manager → area manager (no space) → area agents: the area manager leads its team under the heading.
  const lead = groupBySpace(buildOrg([
    agent('m', { name: 'Manager' }),
    agent('am', { name: 'Brand lead', managerId: 'm' }),
    agent('ed', { name: 'Editor', managerId: 'am', spaceId: 'sp_brand' }),
    agent('so', { name: 'Social', managerId: 'am', spaceId: 'sp_brand' }),
    agent('note', { name: 'Notes', managerId: 'am' }), // space-less leaf: neutral, stays with its manager
  ]), spaces);
  assert.deepEqual(lead.map((group) => group.space?.id ?? null), [null, 'sp_brand']);
  assert.deepEqual(ids(lead[0].entries), ['m']);
  assert.equal(countReports(lead[0].entries[0]), 0);
  assert.deepEqual(ids(lead[1].entries), ['am']);
  assert.deepEqual(ids(lead[1].entries[0].reports), ['ed', 'note', 'so']);
  assert.equal(countReports(lead[1].entries[0]), 3, 'the area manager keeps its caret and count');

  // Manager → Ed(brand) → Help(no space) → Cut(brand): one brand branch, compared with the group shown.
  const chain = groupBySpace(buildOrg([
    agent('m', { name: 'Manager' }),
    agent('ed', { name: 'Editor', managerId: 'm', spaceId: 'sp_brand' }),
    agent('help', { name: 'Helper', managerId: 'ed' }),
    agent('cut', { name: 'Cutter', managerId: 'help', spaceId: 'sp_brand' }),
  ]), spaces);
  assert.deepEqual(chain.map((group) => [group.space?.id ?? null, ids(group.entries)]), [[null, ['m']], ['sp_brand', ['ed']]]);
  assert.deepEqual(ids(chain[1].entries[0].reports), ['help']);
  assert.deepEqual(ids(chain[1].entries[0].reports[0].reports), ['cut']);

  // A space-less manager with a mixed team stays with its own manager; its reports go to their areas.
  const mixed = groupBySpace(buildOrg([
    agent('m', { name: 'Manager' }),
    agent('ops', { name: 'Ops lead', managerId: 'm' }),
    agent('ed', { name: 'Editor', managerId: 'ops', spaceId: 'sp_brand' }),
    agent('dev', { name: 'Dev', managerId: 'ops', spaceId: 'sp_co' }),
  ]), spaces);
  assert.deepEqual(mixed.map((group) => [group.space?.id ?? null, ids(group.entries)]), [[null, ['m']], ['sp_brand', ['ed']], ['sp_co', ['dev']]]);
  assert.deepEqual(ids(mixed[0].entries[0].reports), ['ops']);
});

test('status: live activity wins; the line prefers the live note, then status note, then role', () => {
  const idle = agent('a', { role: 'Video editor', statusNote: 'stale note' });
  const live = { agentId: 'a', runId: 'run_1', note: 'rendering intro (2/5)', startedAt: 0 };
  assert.equal(effectiveStatus(idle, live), 'working');
  assert.equal(effectiveStatus(idle, undefined), 'idle');
  assert.equal(agentStatusLine(idle, live), 'rendering intro (2/5)');
  assert.equal(agentStatusLine(idle, { ...live, note: '' }), 'Working');
  assert.equal(agentStatusLine(idle, undefined), 'Video editor'); // idle notes are not shown as status
  assert.equal(agentStatusLine(agent('b', { status: 'waiting', statusNote: 'waiting for upload' }), undefined), 'waiting for upload');
  assert.equal(agentStatusLine(agent('c', { status: 'error' }), undefined), 'Error');
});

test('matchesAgent searches name, role and team', () => {
  const mira = agent('m', { name: 'Mira', role: 'Video editor', team: 'Marketing' });
  assert.ok(matchesAgent(mira, 'mir'));
  assert.ok(matchesAgent(mira, 'VIDEO'));
  assert.ok(matchesAgent(mira, 'market'));
  assert.ok(!matchesAgent(mira, 'finance'));
  assert.ok(matchesAgent(mira, ' '));
});

test('runEntries joins tool calls with their results and keeps other items in order', () => {
  const item = (id: string, seq: number, kind: RunItem['kind'], data: Record<string, unknown>): RunItem => ({ id, runId: 'run', seq, kind, data, createdAt: 0 });
  const entries = runEntries([
    item('r1', 3, 'tool_result', { callId: 'c1', ok: true, preview: 'done' }),
    item('c1', 2, 'tool_call', { callId: 'c1', args: { a: 1 } }),
    item('n', 1, 'reasoning', { summary: 'plan first' }),
    item('c2', 4, 'tool_call', { callId: 'c2' }),
    item('r9', 5, 'tool_result', { callId: 'c9', ok: false }), // orphan result stays visible
  ]);
  assert.deepEqual(entries.map((entry) => (entry.kind === 'tool' ? `tool:${entry.call.id}:${entry.result?.id ?? '-'}` : `item:${entry.item.id}`)), [
    'item:n', 'tool:c1:r1', 'tool:c2:-', 'item:r9',
  ]);
});

test('previewData formats and truncates', () => {
  assert.equal(previewData(undefined), '');
  assert.equal(previewData('plain'), 'plain');
  assert.equal(previewData({ a: 1 }), '{\n  "a": 1\n}');
  assert.equal(previewData('x'.repeat(10), 5), 'xxxx…');
});

test('applyArchived: an archived agent comes in newest first, a restored one goes out, active ones never join', () => {
  const one = agent('ag_1', { archivedAt: 10 });
  const two = agent('ag_2', { archivedAt: 20 });
  let list = applyArchived([], one);
  list = applyArchived(list, two);
  assert.deepEqual(list.map((entry) => entry.id), ['ag_2', 'ag_1']);
  list = applyArchived(list, { ...one, archivedAt: 30 });
  assert.deepEqual(list.map((entry) => entry.id), ['ag_1', 'ag_2'], 'archived again: moved to the top, not doubled');
  list = applyArchived(list, { ...one, archivedAt: undefined });
  assert.deepEqual(list.map((entry) => entry.id), ['ag_2'], 'restored: out');
  assert.deepEqual(applyArchived(list, agent('ag_3')).map((entry) => entry.id), ['ag_2'], 'active agents never join');
});
