// Pure task center rules of the UI (src/ui/tasks/center-model.ts): the recipient menu (agents,
// managers' branches, teams; archived agents left out; the active people when
// the owner's composer passes them – F-52; "Me" – B-041) and its labels, the short progress/blocker line of a row, the questions a task detail answers in place, which
// work counts as unassigned (waiting unowned work too), which task message is only a reference, and
// the title of a pending post.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { Person } from '../../../src/shared/model/people.ts';
import type { Task, TaskView } from '../../../src/shared/model/tasks.ts';
import {
  ME_RECIPIENT, ME_TARGET, TO_MY_DAY, isMine, isReference, isUnassigned, openQuestions, postTitle, progressLine, recipientGroups, sameTarget,
  targetLabel,
} from '../../../src/ui/tasks/center-model.ts';

const agent = (id: string, name: string, extra: Partial<Agent> = {}) => ({ id, name, role: '', ...extra }) as Agent;
const ORG = [
  agent('ag_mia', 'Mia', { role: 'Manager' }),
  agent('ag_vic', 'Vic', { role: 'Video editor', managerId: 'ag_mia', team: 'Video' }),
  agent('ag_ted', 'Ted', { managerId: 'ag_vic', team: 'video ' }),
  agent('ag_old', 'Old', { archivedAt: 1, team: 'Sales' }),
];
const names: Record<string, string> = { ag_mia: 'Mia', ag_vic: 'Vic', ag_ted: 'Ted' };
const nameOf = (id: string) => names[id] ?? 'Former member';

const view = (patch: Partial<TaskView> = {}): TaskView => ({
  id: 'task_1', conversationId: 'ch_inbox', messageId: 'msg_1', title: 'Cut the intro', notes: '', status: 'open', assigneeKind: 'team',
  createdBy: 'human', priority: 0, ledger: {}, attempts: 0, sort: 0, rev: 1, createdAt: 10, updatedAt: 10,
  steps: [], progress: { done: 0, total: 0 }, conversationTitle: 'Inbox', running: false, ...patch,
});

test('recipients: agents by name, managers with reports as branches, teams by name – archived agents left out', () => {
  const groups = recipientGroups(ORG);
  assert.deepEqual(groups.agents.map((entry) => entry.label), ['Mia', 'Ted', 'Vic']);
  assert.deepEqual(groups.agents.find((entry) => entry.label === 'Vic')?.hint, 'Video editor');
  assert.deepEqual(groups.branches.map((entry) => [entry.label, entry.hint, entry.target.kind]), [['Mia', '2 agents', 'branch'], ['Vic', '1 agent', 'branch']]);
  assert.deepEqual(groups.teams.map((entry) => [entry.label, entry.hint, entry.target]), [['Video', '2 agents', { kind: 'team', id: 'Video' }]], 'one team, names folded');
});

test('recipient labels: Auto, the agent, a branch, a team – undefined once it is gone', () => {
  assert.equal(targetLabel(undefined, ORG), 'Auto');
  assert.equal(targetLabel({ kind: 'agent', id: 'ag_vic' }, ORG), 'Vic');
  assert.equal(targetLabel({ kind: 'branch', id: 'ag_mia' }, ORG), "Mia's branch");
  assert.equal(targetLabel({ kind: 'team', id: 'video' }, ORG), 'Video team');
  assert.equal(targetLabel({ kind: 'team', id: 'Ops team' }, [agent('ag_o', 'O', { team: 'Ops team' })]), 'Ops team', 'no "team team"');
  assert.equal(targetLabel({ kind: 'agent', id: 'ag_old' }, ORG), undefined, 'archived');
  assert.equal(targetLabel({ kind: 'branch', id: 'ag_ted' }, ORG), undefined, 'nobody reports to Ted');
  assert.equal(targetLabel({ kind: 'team', id: 'Sales' }, ORG), undefined, 'only an archived agent was in it');
  assert.equal(sameTarget({ kind: 'team', id: 'Video' }, { kind: 'team', id: 'video ' }), true);
  assert.equal(sameTarget({ kind: 'agent', id: 'ag_vic' }, { kind: 'branch', id: 'ag_vic' }), false);
});

const person = (id: string, name: string, extra: Partial<Person> = {}) => ({ id, name, title: '', status: 'active', owner: false, ...extra }) as Person;
const PEOPLE = [
  person('human', 'Sam Owner', { owner: true, title: 'CEO' }),
  person('per_zoe', 'Zoe Hart', { title: 'Designer' }),
  person('per_ben', 'Ben Vogt'),
  person('per_ina', 'Ina Invited', { status: 'invited' }),
  person('per_rod', 'Rod Removed', { status: 'revoked' }),
];

test("recipients: the active people only when passed (the owner's composer) – never the owner, an invited or a removed person", () => {
  assert.deepEqual(recipientGroups(ORG).people, [], 'no people unless the caller passes them');
  const groups = recipientGroups(ORG, PEOPLE);
  assert.deepEqual(groups.people, [
    { target: { kind: 'person', id: 'per_ben' }, label: 'Ben Vogt' },
    { target: { kind: 'person', id: 'per_zoe' }, label: 'Zoe Hart', hint: 'Designer' },
  ]);
  assert.deepEqual(groups.agents.map((entry) => entry.label), ['Mia', 'Ted', 'Vic'], 'agents unchanged');
  assert.equal(targetLabel({ kind: 'person', id: 'per_zoe' }, ORG, PEOPLE), 'Zoe Hart');
  assert.equal(targetLabel({ kind: 'person', id: 'per_zoe' }, ORG), undefined, 'without the people list (a phone): back to Auto');
  assert.equal(targetLabel({ kind: 'person', id: 'per_ina' }, ORG, PEOPLE), undefined, 'not joined yet');
  assert.equal(targetLabel({ kind: 'person', id: 'per_rod' }, ORG, PEOPLE), undefined, 'removed');
  assert.equal(targetLabel({ kind: 'person', id: 'human' }, ORG, PEOPLE), undefined, 'never the owner');
  assert.equal(sameTarget({ kind: 'person', id: 'per_zoe' }, { kind: 'agent', id: 'per_zoe' }), false);
});

test('"Me" (B-041): a recipient right after Auto that names the person, its label, never a colleague', () => {
  assert.deepEqual(ME_RECIPIENT, { target: { kind: 'me', id: 'human' }, label: 'Me', hint: '→ My day' });
  assert.equal(targetLabel(ME_TARGET, ORG), 'Me');
  assert.equal(targetLabel({ kind: 'me', id: 'per_zoe' }, ORG, PEOPLE), undefined, '"me" names the person only');
  assert.equal(sameTarget(ME_TARGET, { kind: 'person', id: 'human' }), false);
  assert.equal(TO_MY_DAY, '→ My day');
  assert.equal(isMine({ assigneeKind: 'human' }), true);
  assert.equal(isMine({ assigneeKind: 'human', assigneeId: 'human' }), true);
  assert.equal(isMine({ assigneeKind: 'human', assigneeId: 'per_zoe' }), false, 'a colleague\'s to-do');
  assert.equal(isMine({ assigneeKind: 'agent', assigneeId: 'ag_vic' }), false);
});

test('progress line: wait or block first, then the live note, the next step, the latest own report', () => {
  const step = (title: string, status: Task['status'], sort: number) => ({ ...view({ id: `st_${sort}`, title, status, sort }), parentId: 'task_1' }) as Task;
  assert.equal(progressLine(view({ status: 'blocked', assigneeKind: 'agent', assigneeId: 'ag_vic', waitingOn: { kind: 'external', reason: 'API down', since: Date.UTC(2026, 9, 23, 9) } }), { nameOf })?.startsWith('Stuck since '), true);
  const working = view({ status: 'working', assigneeKind: 'agent', assigneeId: 'ag_vic', running: true, steps: [step('Cut', 'done', 1), step('Color', 'open', 2)] });
  assert.equal(progressLine(working, { note: 'rendering intro (2/5)', nameOf }), 'rendering intro (2/5)');
  assert.equal(progressLine({ ...working, running: false }, { nameOf }), 'Next: Color');
  assert.equal(progressLine(view({ assigneeKind: 'agent', assigneeId: 'ag_vic', ledger: { facts: ['Draft is in the shared folder', 'Verifier: missing the outro'] } }), { nameOf }), 'Draft is in the shared folder', 'the verifier\'s notes are not the owner\'s report');
  assert.equal(progressLine(view({ assigneeKind: 'agent', assigneeId: 'ag_vic' }), { nameOf }), null, 'nothing invented');
  assert.equal(progressLine(view({ status: 'done', result: { summary: 'Done: **intro** cut', verification: 'verified' } as TaskView['result'] }), { nameOf }), 'Done: intro cut');
});

test('questions answered in the detail: open human steps with a catalog widget, not mini-apps', () => {
  const human = (id: string, widget: Task['widget'], status: Task['status'] = 'needs_you', sort = 0) => ({ ...view({ id, assigneeKind: 'human', status, widget, sort }), parentId: 'task_1' }) as Task;
  const steps = [
    human('st_choice', { type: 'choice', question: 'Red or blue?', options: [] } as unknown as Task['widget'], 'needs_you', 2),
    human('st_app', { type: 'app' } as unknown as Task['widget'], 'needs_you', 1),
    human('st_done', { type: 'confirm' } as unknown as Task['widget'], 'done'),
    human('st_plain', undefined),
    { ...view({ id: 'st_agent', assigneeKind: 'agent', assigneeId: 'ag_vic', widget: { type: 'confirm' } as unknown as Task['widget'] }), parentId: 'task_1' } as Task,
  ];
  assert.deepEqual(openQuestions(steps).map((step) => step.id), ['st_choice']);
});

test('Unassigned: open or waiting top-level team work without an owner', () => {
  assert.equal(isUnassigned(view({})), true);
  assert.equal(isUnassigned(view({ status: 'working' })), false, 'a team task someone works on is not unassigned');
  assert.equal(isUnassigned(view({ status: 'waiting' })), true, 'waiting for other tasks first, still without an owner (the router routes it too)');
  assert.equal(isUnassigned(view({ status: 'waiting', parentId: 'task_0' })), false, 'a step is never unassigned work');
  assert.equal(isUnassigned(view({ status: 'done' })), false);
  assert.equal(isUnassigned(view({ status: 'waiting', assigneeKind: 'agent', assigneeId: 'ag_vic' })), false);
});

test('a task message is a reference when the task is anchored elsewhere; the post title follows the runtime rule', () => {
  assert.equal(isReference({ id: 'msg_inbox' }, view({ messageId: 'msg_owner' })), true, 'a task anchored in another chat');
  assert.equal(isReference({ id: 'msg_1' }, view()), false, 'the anchor is the task itself');
  assert.equal(isReference({ id: 'msg_x' }, view({ messageId: undefined })), true, 'B-054: a chat-free task shared here is a reference, never a second full card');
  assert.equal(postTitle('  Fix the login\nwith details'), 'Fix the login');
  assert.equal(postTitle('', ['brief.pdf']), 'brief.pdf');
  assert.equal(postTitle(''), 'Files');
  assert.equal(postTitle('x'.repeat(200)).length, 120);
});
