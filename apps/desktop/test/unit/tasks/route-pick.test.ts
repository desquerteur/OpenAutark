// Unowned team work gets its owner from one decision-model pick (B-078 D11, src/runtime/tasks/route-pick.ts): a sure
// pick assigns it (the agent is woken as owner), an unsure one, no model or a single candidate fall back to the
// manager (wakeLead), the choice is among the active agents with their roles – the chat's agent members for work in
// a chat – and an answer that arrives after someone took the work changes nothing.
// Owns: these assertions only. Never: real engines or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { center, company, scriptedDecisions } from '../task-center/fixture.ts';

test('a sure pick owns the work at once – the picked agent is woken, the manager is not', async () => {
  const decisions = scriptedDecisions({ choice: 'Tom', confidence: 0.9, by: 'model' } as never);
  const h = center({ decisions });
  company(h);
  const { task } = h.quick('Cut the trailer\nthe 30 second one');
  await h.settle();
  const after = h.tasks.get(task.id)!;
  assert.equal(after.assigneeKind, 'agent');
  assert.equal(after.assigneeId, 'ag_tom');
  assert.ok(h.wakes.list('ag_tom').some((wake) => wake.taskId === task.id), 'Tom is woken as owner');
  assert.equal(h.wakes.list('ag_mara').some((wake) => wake.taskId === task.id), false, 'no manager turn to place it');
  const [asked] = decisions.asked;
  assert.equal(asked.type, 'choice');
  assert.deepEqual([...asked.options!].sort(), ['Lea', 'Mara', 'Tom']);
  assert.match(asked.context!, /Cut the trailer/);
  assert.match(asked.context!, /Tom \(Video editor\)/);
});

test('unsure, no model or no answer: the manager decides as before', async () => {
  for (const decisions of [
    scriptedDecisions({ choice: 'Tom', confidence: 0.3, by: 'model' } as never),
    scriptedDecisions({ choice: 'Tom', confidence: 0.9, by: 'model' } as never, false),
    scriptedDecisions(new Error('offline')),
    scriptedDecisions({ choice: 'Somebody else', confidence: 0.9, by: 'model' } as never),
  ]) {
    const h = center({ decisions });
    company(h);
    const { task } = h.quick('Book the venue');
    await h.settle();
    assert.equal(h.tasks.get(task.id)!.assigneeKind, 'team');
    assert.ok(h.wakes.list('ag_mara').some((wake) => wake.taskId === task.id), 'the manager decides who does it');
  }
});

test('an answer that arrives after someone took the work changes nothing', async () => {
  let release: (value: unknown) => void = () => {};
  const late = new Promise((resolve) => { release = resolve; });
  const decisions = scriptedDecisions(async () => { await late; return { choice: 'Tom', confidence: 0.9, by: 'model' } as never; });
  const h = center({ decisions });
  company(h);
  const { task } = h.quick('Fix the footer');
  h.tasks.assign(task.id, { kind: 'agent', id: 'ag_lea' }, HUMAN_ID);
  release(undefined);
  await h.settle();
  assert.equal(h.tasks.get(task.id)!.assigneeId, 'ag_lea');
});

test('work in a chat is picked among its agent members only – nobody joins a chat by the pick', async () => {
  const decisions = scriptedDecisions({ choice: 'Tom', confidence: 0.9, by: 'model' } as never);
  const h = center({ decisions });
  company(h);
  const chat = h.chats.create({ agentIds: ['ag_tom', 'ag_lea'], createdBy: HUMAN_ID });
  const task = h.tasks.create({ conversationId: chat.id, title: 'Cut the teaser', assigneeKind: 'team', createdBy: HUMAN_ID });
  await h.settle();
  assert.deepEqual([...decisions.asked[0].options!].sort(), ['Lea', 'Tom']);
  assert.equal(h.tasks.get(task.id)!.assigneeId, 'ag_tom');
});

test('work handed back to the team while it is blocked still reaches someone when the pick is unsure', async () => {
  const decisions = scriptedDecisions({ choice: 'Tom', confidence: 0.3, by: 'model' } as never);
  const h = center({ decisions });
  company(h);
  const task = h.tasks.create({ title: 'Renew the domain', assigneeKind: 'agent', assigneeId: 'ag_lea', createdBy: HUMAN_ID });
  h.tasks.setStatus(task.id, 'blocked', 'ag_lea', 'needs another hand');
  h.tasks.assign(task.id, { kind: 'team' }, 'ag_lea');
  await h.settle();
  assert.equal(decisions.asked.length, 1, 'the pick ran');
  assert.ok(h.wakes.list('ag_mara').some((wake) => wake.taskId === task.id), 'the manager decides who does it');
});
