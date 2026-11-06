// Work's two regions (B-078 D10, src/ui/tasks/work-model.ts): what lands on "For you" (the agents' work that needs
// the person), what the report says (alsoHandled lines and work nobody asked for, the last three days, deduplicated,
// newest first, at most eight), one owner's slim rows, the search, what Work lists at all – and stuckOf, which the
// team view keeps using.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAUSED_REASON } from '../../../src/shared/model/task-pause.ts';
import type { TaskView } from '../../../src/shared/model/tasks.ts';
import { REPORT_MAX, forYou, isOpenWork, matchingWork, needsThePerson, ownerWork, report, stuckOf } from '../../../src/ui/tasks/work-model.ts';
import { ANNA, DAY, HOUR, MARA, NOW, TOM, ids, task, todo, unowned } from './fixture.ts';

const result = (summary: string, alsoHandled?: string[]) => ({ summary, evidence: [], verification: 'claimed_by_agent' as const, ...(alsoHandled ? { alsoHandled } : {}) });
const step = (patch: Partial<TaskView['steps'][number]> = {}) => ({
  id: `step_${Math.random()}`, title: 'Which logo?', status: 'open', assigneeKind: 'human', sort: 0, createdAt: NOW, widget: { type: 'choice', question: 'Which logo?', options: ['A', 'B'] }, ...patch,
}) as unknown as TaskView['steps'][number];

test('stuckOf: blocked, paused, no owner, long waits, escalated and failing work – with why and since', () => {
  const why = (patch: Parameters<typeof task>[0]) => stuckOf(task(patch), NOW);
  assert.deepEqual(why({ status: 'blocked', waitingOn: { kind: 'external', reason: 'No YouTube login', since: NOW - 5 * DAY } }), { why: 'No YouTube login', since: NOW - 5 * DAY });
  assert.deepEqual(why({ status: 'open', waitingOn: { kind: 'human', reason: PAUSED_REASON, since: NOW - DAY } }), { why: 'Paused by you', since: NOW - DAY });
  assert.equal(why({ status: 'waiting', waitingOn: { kind: 'external', reason: 'Printer', since: NOW - DAY } }), null, 'a day is no long wait');
  assert.equal(why({ status: 'waiting', waitingOn: { kind: 'schedule', reason: 'Until Monday', since: NOW - 5 * DAY, until: NOW + DAY } }), null, 'a timed wait still ahead');
  assert.deepEqual(why({ status: 'working', ledger: { escalation: 'other_approach', stalls: 3, lastProgressAt: NOW - HOUR } }), { why: 'No progress in 3 tries', since: NOW - HOUR });
  assert.deepEqual(stuckOf(unowned({ createdAt: NOW - 2 * HOUR }), NOW), { why: 'No owner yet', since: NOW - 2 * HOUR });
  assert.equal(why({ status: 'done', ledger: { escalation: 'manager' } }), null, 'finished work is never stuck');
});

test('For you: agent work that waits on the person or asks them in a step – never their own pause, to-dos or quiet work', () => {
  const asks = task({ title: 'Logo', status: 'needs_you', waitingOn: { kind: 'human', reason: 'Which logo?', since: NOW - HOUR } });
  const openAsk = task({ title: 'Video', status: 'open', waitingOn: { kind: 'human', reason: 'Record the intro', since: NOW - HOUR } });
  const stepAsk = task({ title: 'Launch', status: 'working', steps: [step()] });
  const answered = task({ title: 'Done step', status: 'working', steps: [step({ status: 'done' })] });
  const appStep = task({ title: 'App', status: 'working', steps: [step({ widget: { type: 'app' } as unknown as TaskView['widget'] })] });
  const paused = task({ status: 'open', waitingOn: { kind: 'human', reason: PAUSED_REASON, since: NOW - HOUR } });
  const quiet = task({ status: 'working' });
  const waitingAgent = task({ status: 'waiting', waitingOn: { kind: 'agent', id: TOM, reason: 'Tom builds it', since: NOW - HOUR } });
  const own = todo({ status: 'needs_you' });
  const urgent = task({ title: 'Urgent', status: 'needs_you', priority: 2, waitingOn: { kind: 'human', reason: 'Now', since: NOW } });
  const list = [asks, openAsk, stepAsk, answered, appStep, paused, quiet, waitingAgent, own, urgent];
  assert.deepEqual(ids(forYou(list)), ids([urgent, asks, openAsk, stepAsk]), 'priority first, then board order');
  assert.equal(needsThePerson(paused), false, 'their own pause is no question');
  assert.deepEqual(ids(forYou(list, 'video')), ids([openAsk]), 'the search narrows the cards');
});

test('one owner\'s open work as slim rows; the search finds open work that is no card', () => {
  const mara = task({ title: 'Write the teaser', status: 'working', running: true });
  const maraOpen = task({ title: 'Edit the teaser', status: 'open' });
  const tom = task({ title: 'Fix the footer', assigneeId: TOM });
  const anna = task({ title: 'Pick colours', assigneeKind: 'human', assigneeId: ANNA });
  const team = unowned({ title: 'Book the venue' });
  const card = task({ title: 'Teaser logo', status: 'needs_you', waitingOn: { kind: 'human', reason: 'Logo?', since: NOW } });
  const list = [maraOpen, mara, tom, anna, team, card, todo({ title: 'teaser call' })];
  assert.deepEqual(ids(ownerWork(list, MARA)), ids([mara, card, maraOpen]), 'running first');
  assert.deepEqual(ids(ownerWork(list, ANNA)), ids([anna]), 'a person as owner');
  assert.deepEqual(ids(ownerWork(list, 'team')), ids([team]), 'Unassigned');
  assert.deepEqual(ids(matchingWork(list, 'teaser')), ids([mara, maraOpen]), 'the card has its own place; the person\'s to-do is My day\'s');
  assert.deepEqual(matchingWork(list, ''), [], 'no search: no rows');
});

test('the report: alsoHandled lines and work nobody asked for, the last three days, deduplicated, newest first, at most eight', () => {
  const asked = task({ title: 'Draft the brief', status: 'done', createdBy: 'human', completedAt: NOW - HOUR, result: result('Brief is in the folder', ['Renewed the domain', 'The VPS disk was full – cleaned 12 GB']) });
  const nightly = { conversationId: undefined, origin: { source: 'schedule:sch_1', label: 'Routine "Backup"' } };
  const unasked = task({ title: 'Nightly backup', status: 'done', createdBy: MARA, completedAt: NOW - 2 * HOUR, result: result('Backup ran, 3 GB'), ...nightly });
  // An agent's task for a person's request in a chat (or chat-free from the system) is no line of its own.
  const forARequest = task({ title: 'Find a venue', status: 'done', createdBy: MARA, conversationId: 'conv_1', completedAt: NOW - 90 * 60_000, result: result('Booked the hall') });
  const fromSystem = task({ title: 'Sort the files', status: 'done', createdBy: MARA, conversationId: undefined, origin: { source: 'system', label: 'System' }, completedAt: NOW - 90 * 60_000, result: result('Sorted') });
  const duplicate = task({ title: 'Other', status: 'done', createdBy: 'human', completedAt: NOW - 3 * HOUR, result: result('x', ['renewed the domain']) });
  const old = task({ title: 'Old', status: 'done', createdBy: MARA, completedAt: NOW - 4 * DAY, result: result('Too old') });
  const cancelled = task({ status: 'cancelled', createdBy: MARA, completedAt: NOW - HOUR, result: result('Gave up') });
  const ownTodo = todo({ status: 'done', createdBy: 'ag_x', completedAt: NOW - HOUR, result: result('Answered', ['Not mine']) });
  const sub = task({ status: 'done', parentId: 'task_p', createdBy: MARA, completedAt: NOW - HOUR, result: result('A step', ['Step note']) });
  const lines = report([old, duplicate, unasked, asked, cancelled, ownTodo, sub, forARequest, fromSystem], NOW);
  assert.deepEqual(lines.map((line) => line.text), [
    'Renewed the domain', 'The VPS disk was full – cleaned 12 GB', 'Nightly backup: Backup ran, 3 GB',
  ]);
  assert.equal(lines[0].task.id, asked.id, 'each line opens its task');
  assert.deepEqual(report([asked], NOW, { query: 'vps' }).map((line) => line.text), ['The VPS disk was full – cleaned 12 GB']);
  const many = Array.from({ length: 12 }, (_, index) => task({ status: 'done', createdBy: MARA, completedAt: NOW - index * 1000, result: result(`Line ${index}`), ...nightly }));
  assert.equal(report(many, NOW).length, REPORT_MAX);
  assert.deepEqual(report(many, NOW, { max: 3 }).map((line) => line.task.id), ids(many.slice(0, 3)));
});

test('Work lists everyone\'s work but the person\'s own to-dos: My day has those', () => {
  const agent = task({ status: 'working' });
  const colleague = task({ status: 'open', assigneeKind: 'human', assigneeId: ANNA });
  const team = unowned();
  const own = todo({ status: 'open' });
  const ringing = todo({ status: 'needs_you' });
  const ownBlocked = todo({ status: 'blocked', waitingOn: { kind: 'external', reason: 'No key', since: NOW - HOUR } });
  const sub = task({ status: 'working', parentId: agent.id });
  const all = [agent, colleague, team, own, ringing, ownBlocked, sub];
  assert.deepEqual(all.filter((entry) => isOpenWork(entry)).map((entry) => entry.id), ids([agent, colleague, team, ownBlocked]));
  assert.ok(isOpenWork(own, { keepOwn: true }), 'a person\'s device keeps her own to-dos');
  assert.ok(!isOpenWork(sub, { keepOwn: true }), 'steps never');
});
