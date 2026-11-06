// Quick tasks and "Send to…" (src/runtime/tasks/quick.ts): what the person typed becomes one plain task – for a
// target agent, a manager's branch, a team, the person themselves, or (no target) unowned team work whose responsible
// manager is woken to decide; tasks.route hands unowned work to a target or wakes that manager again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeTask } from '../../../src/runtime/tasks/quick.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { center, company } from './fixture.ts';

test('without a target the work is the team\'s and the responsible manager hears of it', () => {
  const h = center();
  company(h);
  const { task } = h.quick('Book the venue\nfor 40 people');
  assert.equal(task.title, 'Book the venue');
  assert.equal(task.notes, 'for 40 people', 'B-078: the notes hold only what the title does not');
  assert.equal(h.quick('A very long first line '.repeat(8)).task.notes.length > 120, true, 'a cut first line keeps the whole text');
  assert.equal(task.assigneeKind, 'team');
  assert.ok(h.wakes.list('ag_mara').some((wake) => wake.taskId === task.id), 'the manager decides who does it');
});

test('an agent, a team or the person as target', () => {
  const h = center();
  company(h);
  assert.equal(h.quick('Cut the trailer', { target: { kind: 'agent', id: 'ag_tom' } }).task.assigneeId, 'ag_tom');
  assert.equal(h.quick('Fix the site', { target: { kind: 'team', id: 'Web' } }).task.assigneeId, 'ag_lea');
  const mine = h.quick('Call the bank', { target: { kind: 'me', id: HUMAN_ID } }).task;
  assert.equal(mine.assigneeKind, 'human');
  assert.equal(mine.widget?.type, 'confirm');
});

test('a retried post returns the first task; Send to… hands unowned work on', () => {
  const h = center();
  company(h);
  const first = h.quick('Write the newsletter', { clientId: 'c1' }).task;
  assert.equal(h.quick('Write the newsletter', { clientId: 'c1' }).task.id, first.id);
  const routed = routeTask(h.s, first.id, { kind: 'agent', id: 'ag_lea' }, HUMAN_ID);
  assert.equal(routed.assigneeId, 'ag_lea');
  assert.ok(h.wakes.list('ag_lea').some((wake) => wake.taskId === first.id));
});
