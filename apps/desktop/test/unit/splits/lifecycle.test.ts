// B-057 track A: a split group's life with a fake dispatcher – created pending (`ultra` when the person's latest message
// suggested it) and started only
// when the parent's turn ends; parts start on lanes (turnFor / inputFor), at most SPLIT_LIMITS.runningPerAgent per
// agent; 'busy' and 'refused' keep a part queued until a lane frees; a run's end settles the group, which wakes the
// parent ONCE on its thread with reason 'child'; the person's stop of the turn that split means the group never starts.
// Owns: these lifecycle checks. Never: an engine or the real dispatcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPLIT_LIMITS, type SplitGroupView } from '../../../src/shared/model/splits.ts';
import { CHAT, PARENT, part, splitAndEnd, world } from './fixture.ts';

test('a group waits for the end of the turn that split, then its parts run on lanes', () => {
  const w = world({ ultra: true });
  const view = w.splits.create(w.ctx(), { goal: 'Review the release', parts: [part('Tests'), part('Docs', { context: 'brief', model: 'cheap', effort: 'low' })] });
  assert.equal(view.status, 'pending');
  assert.equal(view.ultra, true, 'the person\'s latest message suggested Ultra');
  const plain = world().splits.create(w.ctx(), { goal: 'Plain', parts: [part('A')] });
  assert.equal(plain.ultra, false, 'an earlier message\'s suggestion does not count');
  assert.deepEqual(view.splits.map((split) => [split.idx, split.of, split.status]), [[1, 2, 'pending'], [2, 2, 'pending']]);
  assert.equal(view.thread, CHAT);
  assert.equal(w.of('split.upserted').length, 1, 'the new group is announced');
  w.splits.pump();
  assert.deepEqual(w.lanes.started, [], 'nothing starts while the parent turn runs');

  w.splits.afterParentTurn(PARENT, 'done');
  assert.equal(w.lanes.started.length, 2);
  const [first, second] = w.lanes.turns;
  assert.equal(first.turn.idx, 1);
  assert.equal(first.turn.parentRunId, PARENT);
  assert.equal(first.turn.parentThread, CHAT);
  assert.equal(first.turn.parentConversationId, CHAT);
  assert.equal(first.turn.context, 'fork');
  assert.equal(first.turn.firstTurn, true);
  assert.equal(first.turn.cwd, 'C:/work/repo', 'parts share the parent folder by default');
  assert.deepEqual([second.turn.model, second.turn.effort, second.turn.context], ['cheap', 'low', 'brief']);
  assert.equal(first.notes[0].text, 'My part #1 of 2 – Tests\nDo tests.\nI bring back: a concise result my main self can merge');
  const running = w.splits.get(w.lanes.started[0])!;
  assert.equal(running.split.status, 'running');
  assert.equal(running.split.attempts, 1);
  assert.equal(running.group.status, 'running');
  assert.equal(running.split.run?.status, 'running', 'the view joins the split run');
});

test('settled once every part ended: ONE child wake on the parent thread, cost summed', () => {
  const w = world();
  const groupId = splitAndEnd(w, [part('A'), part('B'), part('C')]);
  const [a, b, c] = w.lanes.started;
  w.lanes.end(a, 'done', { answer: 'Result A', costUsd: 0.01 });
  w.lanes.end(b, 'failed', { error: 'The model refused.' });
  assert.equal(w.wakes.list('ag_ava').length, 0, 'no wake before the last part');
  const runC = w.lanes.end(c, 'done', { answer: 'Result C', costUsd: 0.02 });
  const wakes = w.wakes.list('ag_ava');
  assert.equal(wakes.length, 1, 'exactly one wake');
  assert.equal(wakes[0].reason, 'child');
  assert.equal(wakes[0].conversationId, CHAT);
  assert.match(wakes[0].note ?? '', /3 splits for "Review the release" ended \(2 done, 1 failed\)/);
  const group = w.splits.list({ groupId })[0];
  assert.equal(group.status, 'settled');
  assert.equal(group.costUsd, 0.03);
  // A late duplicate end changes nothing and wakes nobody again.
  w.splits.onSplitRunEnd(c, { runId: runC, status: 'done' });
  assert.equal(w.wakes.list('ag_ava').length, 1);
  const last = w.of('split.upserted').at(-1) as SplitGroupView;
  assert.equal(last.status, 'settled');
});

test('a chat-free parent is woken on its task, else on its source', () => {
  const w = world();
  w.runs.start({ id: 'run_task', agentId: 'ag_ava', taskId: 'task_1', trigger: 'task' });
  w.splits.create(w.ctx({ runId: 'run_task', conversationId: undefined, taskId: 'task_1', thread: 'task:task_1' }), { goal: 'Sort mail', parts: [part('One')] });
  w.splits.afterParentTurn('run_task', 'done');
  w.lanes.end(w.lanes.started[0], 'done', { answer: 'ok' });
  const wake = w.wakes.list('ag_ava')[0];
  assert.equal(wake.taskId, 'task_1');
  assert.equal(wake.conversationId, undefined);

  w.runs.start({ id: 'run_mail', agentId: 'ag_ben', trigger: 'event', origin: { source: 'app:mail', label: 'New mail' } });
  w.splits.create(w.ctx({ agentId: 'ag_ben', runId: 'run_mail', conversationId: undefined, origin: { source: 'app:mail', label: 'New mail' }, thread: 'src:app:mail' }), { goal: 'Answer mail', parts: [part('One')] });
  w.splits.afterParentTurn('run_mail', 'failed');
  w.lanes.end(w.lanes.started[1], 'done', { answer: 'ok' });
  const mail = w.wakes.list('ag_ben')[0];
  assert.deepEqual(mail.origin, { source: 'app:mail', label: 'New mail' });
  assert.equal(w.splits.pendingResults('ag_ben', 'src:app:mail')?.groupIds.length, 1);
});

test('at most runningPerAgent parts run at once; a freed lane starts the next', () => {
  const w = world();
  splitAndEnd(w, Array.from({ length: 6 }, (_, index) => part(`P${index + 1}`)));
  assert.equal(w.lanes.started.length, SPLIT_LIMITS.runningPerAgent);
  w.lanes.end(w.lanes.started[0], 'done', { answer: 'x' });
  assert.equal(w.lanes.started.length, SPLIT_LIMITS.runningPerAgent + 1, 'the freed lane pumps the next part');
});

test("'busy' and 'refused' keep a part queued (attempt not counted) until a lane frees", () => {
  const w = world();
  w.lanes.answers = ['busy'];
  const groupId = splitAndEnd(w, [part('A'), part('B')]);
  assert.equal(w.lanes.started.length, 0, 'busy: the agent waits');
  const waiting = w.splits.list({ groupId })[0].splits;
  assert.deepEqual(waiting.map((split) => [split.status, split.attempts]), [['queued', 0], ['queued', 0]]);
  w.lanes.answers = ['refused'];
  w.splits.pump();
  assert.equal(w.lanes.started.length, 0);
  w.splits.pump();
  assert.equal(w.lanes.started.length, 2);
  assert.deepEqual(w.splits.list({ groupId })[0].splits.map((split) => split.attempts), [1, 1]);
});

test('without lanes nothing starts and nothing breaks', () => {
  const w = world({ lanes: false });
  const groupId = splitAndEnd(w, [part('A')]);
  assert.equal(w.splits.list({ groupId })[0].splits[0].status, 'queued');
});

test("the person's stop of the turn that split: the group never starts", () => {
  const w = world();
  const view = w.splits.create(w.ctx(), { goal: 'Review', parts: [part('A'), part('B')] });
  w.splits.afterParentTurn(PARENT, 'stopped');
  const group = w.splits.list({ groupId: view.id })[0];
  assert.equal(group.status, 'stopped');
  assert.deepEqual(group.splits.map((split) => split.status), ['stopped', 'stopped']);
  assert.match(group.splits[0].error ?? '', /person stopped the turn that split/);
  assert.equal(w.lanes.started.length, 0);
  assert.equal(w.wakes.list('ag_ava').length, 0);
  w.splits.afterParentTurn(PARENT, 'done');
  assert.equal(w.lanes.started.length, 0, 'a second report changes nothing');
});

test('list and get: filters, active groups and views', () => {
  const w = world();
  const groupId = splitAndEnd(w, [part('A')]);
  assert.equal(w.splits.list({ agentId: 'ag_ava' }).length, 1);
  assert.equal(w.splits.list({ agentId: 'ag_ben' }).length, 0);
  assert.equal(w.splits.list({ parentRunId: PARENT, active: true }).length, 1);
  assert.equal(w.splits.list({ conversationId: CHAT })[0].id, groupId);
  assert.equal(w.splits.list({ groupId, agentId: 'ag_ben' }).length, 0);
  const splitId = w.lanes.started[0];
  w.splits.markFork(splitId, { how: 'ledger', engine: 'codex', accountId: 'acc_1' }); // the turn pipeline records the seeding
  assert.deepEqual(w.splits.get(splitId)!.split.fork, { how: 'ledger', engine: 'codex', accountId: 'acc_1' });
  w.lanes.end(splitId, 'done', { answer: 'A' });
  w.splits.markGathered('run_next', [groupId]);
  assert.equal(w.splits.list({ agentId: 'ag_ava', active: true }).length, 0, 'gathered groups are not active');
  const found = w.splits.get(splitId)!;
  assert.equal(found.group.id, groupId);
  assert.equal(found.split.runs, 1);
  assert.equal(found.split.run?.model, 'codex:gpt-6.1-sol');
  assert.equal(w.splits.get('spl_missing'), undefined);
});
