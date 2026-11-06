// SubconsciousImpl: verify cases, widgetFor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDecisions, fixture } from '../context/fixture.ts';
import type { Task } from '../../../src/shared/model/tasks.ts';

const WEEK = 7 * 86_400_000;

test('verify: missing result fails, no done-condition passes, decision verdicts, no decision model', async () => {
  const result = { summary: 'Page is live', evidence: [{ kind: 'link' as const, label: 'Landing page', ref: 'https://acme.test' }], verification: 'claimed_by_agent' as const };
  const plain = fixture();
  assert.equal((await plain.subconscious.verify(doneTask(), { summary: ' ', evidence: [], verification: 'claimed_by_agent' })).ok, false);
  assert.deepEqual(await plain.subconscious.verify(doneTask(), result), { ok: true, reason: 'no done-condition', checked: false });
  const unchecked = await plain.subconscious.verify(doneTask({ doneWhen: 'The page is reachable over HTTPS' }), result);
  assert.equal(unchecked.ok, true);
  assert.equal(unchecked.checked, false);

  const no = fakeDecisions(() => ({ value: false, confidence: 0.9 }));
  const f = fixture({ decisions: no.service });
  const failed = await f.subconscious.verify(doneTask({ doneWhen: 'The page has a signup form', mode: 'video' }), result);
  assert.equal(failed.ok, false);
  assert.ok(failed.reason.includes('The page has a signup form'));
  assert.equal(no.calls[0].purpose, 'verify');
  assert.equal(no.calls[0].question, 'Does this result satisfy: The page has a signup form?');
  assert.ok(no.calls[0].context!.includes('- link: Landing page (https://acme.test)'));
  assert.ok(no.calls[0].context!.includes('Quality rubric: The video file exists and plays.'));

  const yes = fakeDecisions(() => ({ value: true, confidence: 0.8 }));
  const g = fixture({ decisions: yes.service });
  const passed = await g.subconscious.verify(doneTask({ doneWhen: 'The page is live' }), result);
  assert.deepEqual([passed.ok, passed.checked], [true, true]);

  const unsure = fakeDecisions(() => ({ value: false, confidence: 0.2 }));
  const h = fixture({ decisions: unsure.service });
  const soft = await h.subconscious.verify(doneTask({ doneWhen: 'The page is live' }), result);
  assert.deepEqual([soft.ok, soft.checked], [true, false]);
});

test('widgetFor: keyword fallback without a decision model; decision choice with details carried over', async () => {
  const f = fixture();
  const timer = await f.subconscious.widgetFor('Remind me at 17:00 to call the tax office');
  assert.equal(timer.type, 'timer');
  assert.ok(typeof timer.at === 'string');
  assert.deepEqual(await f.subconscious.widgetFor('Record the intro video'), { type: 'record', mode: 'video', instructions: 'Record the intro video' });

  const choose = fakeDecisions((request) => ({ choice: request.options!.find((option) => option.startsWith('upload:')) }));
  const g = fixture({ decisions: choose.service });
  const upload = await g.subconscious.widgetFor('Send me the receipts from March');
  assert.equal(choose.calls[0].purpose, 'widget');
  assert.deepEqual(upload, { type: 'upload', label: 'Send me the receipts from March' });

  const timerChoice = fakeDecisions((request) => ({ choice: request.options!.find((option) => option.startsWith('timer:')) }));
  const h = fixture({ decisions: timerChoice.service });
  const alarm = await h.subconscious.widgetFor('Call mum in 20 min');
  assert.equal(alarm.type, 'timer');
  assert.equal(alarm.duration, 'PT20M');
});

function doneTask(extra: Partial<Task> = {}): Task {
  return { id: 'task_1', conversationId: 'ch_1', title: 'Write the landing page', notes: '', status: 'done', assigneeKind: 'agent', createdBy: 'human', priority: 0, ledger: {}, attempts: 1, sort: 0, rev: 1, createdAt: 0, updatedAt: 0, ...extra };
}
