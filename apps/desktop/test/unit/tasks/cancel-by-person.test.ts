// B-054 fix (live N4/N6): a task the person cancelled is not reopened by an agent on its own – tasks.update {status}
// is refused with the way to ask; the person (or the system) may still reopen it, and an agent's own cancel stays its own.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { agent, center } from '../task-center/fixture.ts';

function setup() {
  const h = center({});
  h.org.add(agent('ag_lea', 'Lea', { role: 'Assistant', createdAt: 1 }));
  return h;
}

test('an agent that cancelled its own task may reopen it', () => {
  const h = setup();
  const task = h.tasks.create({ title: 'Draft the mail', assigneeKind: 'agent', assigneeId: 'ag_lea', createdBy: 'ag_lea' });
  h.tasks.setStatus(task.id, 'cancelled', 'ag_lea');
  assert.equal(h.tasks.setStatus(task.id, 'open', 'ag_lea').status, 'open');
});
