import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journal, recordShutdownRuns, truncateData } from '../../../src/runtime/runs/journal.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { clock, memoryDb, recordingBus } from '../store/helpers.ts';

function setup() {
  const db = memoryDb();
  const recorder = recordingBus();
  const time = clock();
  return { db, time, journal: new Journal({ db, bus: recorder.bus, clock: time }), ...recorder };
}

test('start → items with sequence → finish; events emitted', () => {
  const { journal, time, of } = setup();
  const run = journal.start({ id: 'run_1', agentId: 'ag_1', trigger: 'message', conversationId: 'ch_1', engine: 'codex', model: 'gpt' });
  assert.equal(run.status, 'running');
  assert.equal(run.startedAt, time.now());
  const call = journal.item('run_1', { kind: 'tool_call', name: 'web.fetch', data: { url: 'https://x' } });
  const effect = journal.item('run_1', { kind: 'effect', name: 'email.send', data: {}, effectStatus: 'pending', idemKey: 'run_1:email:1' });
  assert.deepEqual([call.seq, effect.seq], [1, 2]);
  journal.updateItem(effect.id, { effectStatus: 'confirmed', data: { messageId: 'm1' } });
  assert.equal(journal.items('run_1')[1].effectStatus, 'confirmed');
  time.advance(5000);
  const done = journal.finish('run_1', { inputTokens: 100, outputTokens: 20, summary: 'sent the mail' });
  assert.equal(done.status, 'done');
  assert.equal(done.endedAt, time.now());
  assert.equal(done.inputTokens, 100);
  assert.equal(of('run.upserted').length, 2);
  assert.equal(of('run.item').length, 3);
  assert.deepEqual(journal.list('ag_1').map((entry) => entry.id), ['run_1']);
  assert.throws(() => journal.start({ id: 'run_1', agentId: 'ag_1', trigger: 'message' }), WorkforceError);
});

test('idempotency key: the same effect is journaled once', () => {
  const { journal, of } = setup();
  journal.start({ id: 'run_1', agentId: 'ag_1', trigger: 'task' });
  const first = journal.item('run_1', { kind: 'effect', data: { n: 1 }, effectStatus: 'pending', idemKey: 'pay:inv-7' });
  const second = journal.item('run_1', { kind: 'effect', data: { n: 2 }, effectStatus: 'pending', idemKey: 'pay:inv-7' });
  assert.equal(second.id, first.id);
  assert.deepEqual(second.data, { n: 1 });
  assert.equal(journal.items('run_1').length, 1);
  assert.equal(of('run.item').length, 1);
  assert.throws(() => journal.item('run_missing', { kind: 'note', data: {} }), WorkforceError);
});

test('reconcile: running → interrupted, pending effects → unknown', () => {
  const { journal, of } = setup();
  journal.start({ id: 'run_a', agentId: 'ag_1', trigger: 'message' });
  journal.start({ id: 'run_b', agentId: 'ag_1', trigger: 'message' });
  journal.item('run_a', { kind: 'effect', data: {}, effectStatus: 'pending' });
  journal.item('run_a', { kind: 'effect', data: {}, effectStatus: 'confirmed' });
  journal.finish('run_b', { status: 'failed', error: 'x'.repeat(500) });
  assert.equal(journal.get('run_b')?.error?.length, 300);
  const before = of('run.upserted').length;
  assert.deepEqual(journal.reconcile(), { interrupted: 1, unknownEffects: 1, runIds: ['run_a'] });
  assert.equal(journal.get('run_a')?.status, 'interrupted');
  assert.ok(journal.get('run_a')?.endedAt);
  assert.equal(journal.get('run_b')?.status, 'failed');
  assert.deepEqual(journal.items('run_a').map((item) => item.effectStatus), ['unknown', 'confirmed']);
  assert.equal(of('run.upserted').length, before + 1);
  assert.deepEqual(journal.reconcile(), { interrupted: 0, unknownEffects: 0, runIds: [] });
});

test('item data is truncated', () => {
  const { journal } = setup();
  journal.start({ id: 'run_1', agentId: 'ag_1', trigger: 'message' });
  const item = journal.item('run_1', { kind: 'tool_result', data: { output: 'y'.repeat(10_000), list: Array.from({ length: 300 }, (_, i) => i) } });
  assert.ok((item.data.output as string).length < 4100);
  assert.equal((item.data.list as unknown[]).length, 101);
  const huge = journal.item('run_1', { kind: 'tool_result', data: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'z'.repeat(3000)])) });
  assert.equal(huge.data.truncated, true);
  assert.equal(truncateData('short'), 'short');
});

test('updateItem merges data: settling an effect keeps the call\'s category and raised category', () => {
  const { journal } = setup();
  journal.start({ id: 'run_1', agentId: 'ag_1', trigger: 'task' });
  const call = journal.item('run_1', { kind: 'tool_call', name: 'browser.act', data: { callId: 'c1', summary: 'click Pay', category: 'device', raised: 'spend' }, effectStatus: 'pending' });
  journal.updateItem(call.id, { effectStatus: 'unknown', data: { callId: 'c1', summary: 'click Pay', ms: 12, externalId: undefined } });
  const saved = journal.items('run_1')[0];
  assert.equal(saved.effectStatus, 'unknown');
  assert.deepEqual(saved.data, { callId: 'c1', summary: 'click Pay', category: 'device', raised: 'spend', ms: 12 });
  journal.updateItem(call.id, { data: { summary: 'click Pay now' } });
  assert.equal(journal.items('run_1')[0].data.summary, 'click Pay now', 'a field given again wins');
});

test('reconcile: runs a graceful stop cut off are named too – their result-less engine calls become unknown; once', () => {
  const { db, time, journal } = setup();
  for (const id of ['run_cut', 'run_late', 'run_crash']) journal.start({ id, agentId: 'ag_1', trigger: 'task' });
  journal.item('run_cut', { kind: 'tool_call', name: 'bash', data: { callId: 'n1', own: true, args: '{"command":"deploy"}' }, effectStatus: 'none' });
  journal.item('run_cut', { kind: 'tool_call', name: 'browser.act', data: { callId: 'c1', category: 'device' }, effectStatus: 'unknown' });
  journal.item('run_late', { kind: 'tool_call', name: 'bash', data: { callId: 'n2', own: true }, effectStatus: 'none' });
  // dispatcher.stop() names its running turns, then each closes itself (finishTurn) …
  recordShutdownRuns({ db, clock: time }, ['run_cut', 'run_late', 'run_crash', 'run_never_started']);
  journal.finish('run_cut', { status: 'interrupted' });
  journal.finish('run_late', { status: 'done' }); // … one finished before the abort landed; one never closed
  const result = journal.reconcile();
  assert.deepEqual(result.runIds, ['run_crash', 'run_cut'], 'the crashed run and the cut-off one; not the finished or unknown ones');
  assert.equal(result.interrupted, 1, 'only runs left running count as interrupted');
  assert.deepEqual(journal.items('run_cut').map((item) => item.effectStatus), ['unknown', 'unknown']);
  assert.equal(journal.items('run_late')[0].effectStatus, 'none');
  assert.deepEqual(journal.reconcile(), { interrupted: 0, unknownEffects: 0, runIds: [] }, 'the list is consumed');

  recordShutdownRuns({ db, clock: time }, ['run_cut']);
  recordShutdownRuns({ db, clock: time }, []); // the dispatcher started again (a cancelled restart)
  assert.deepEqual(journal.reconcile().runIds, []);
});
