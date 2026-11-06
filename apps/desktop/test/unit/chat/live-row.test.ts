// B-075: a run's status as values in its chat row – the throttled writes (chat/streaming.ts), the steps a run item
// becomes (chat/live-row.ts: the newest LIVE_STEPS, `more`, results, thoughts, never an output), the feed from the bus,
// the finished row's meta (ms, lines, steps), the list preview while a row streams, a failed end that keeps the newest
// text and the silent row of a run whose answer is kept internal.

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from './harness.ts';
import { ChatServiceImpl } from '../../../src/runtime/chat/service.ts';
import { MessageRepo } from '../../../src/runtime/chat/message-repo.ts';
import { StreamingRows } from '../../../src/runtime/chat/streaming.ts';
import { applyItem, itemStep, thoughtStep } from '../../../src/runtime/chat/live-row.ts';
import type { RunItem } from '../../../src/shared/model/runs.ts';

function setup() {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  return { h, chat };
}

let seq = 0;
function item(runId: string, kind: RunItem['kind'], data: Record<string, unknown>, name?: string): RunItem {
  seq++;
  return { id: `ri_${seq}`, runId, seq, kind, data, createdAt: seq, ...(name ? { name } : {}) };
}

const call = (runId: string, callId: string, command: string) => item(runId, 'tool_call', { callId, args: JSON.stringify({ command }) }, 'shell');

test('throttle: the first change is written at once, later ones together after the gap; a finished row is never written again', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const { h, chat } = setup();
    const row = h.chats.beginAgentMessage(chat.id, 'ag_tom', 'run_t');
    const rows = new StreamingRows({ msgs: new MessageRepo(h.db), bus: h.bus }, 500);
    rows.begin(row);
    const writes = () => h.of('message.updated').filter((m) => m.id === row.id).map((m) => m.body);
    rows.append(row.id, 'One');
    assert.deepEqual(writes(), ['One'], 'at once after a quiet moment');
    rows.append(row.id, ' two');
    rows.append(row.id, ' three');
    rows.note('run_t', { note: 'running a command' });
    assert.deepEqual(writes(), ['One'], 'held within the gap');
    mock.timers.tick(499);
    assert.equal(writes().length, 1);
    mock.timers.tick(1);
    assert.deepEqual(writes(), ['One', 'One two three'], 'one write for all of them');
    assert.equal(h.chats.message(row.id)!.meta.live?.note, 'running a command');
    rows.append(row.id, ' four');
    h.chats.finishAgentMessage(row.id, { body: 'Done', state: 'final' }); // another writer ends it
    mock.timers.tick(500);
    assert.equal(h.chats.message(row.id)!.body, 'Done', 'a late write never overwrites the finish');
    assert.equal(rows.byRun('run_t'), undefined, 'and the row is forgotten');
  } finally {
    mock.timers.reset();
  }
});

test('steps: the newest six with `more`, a result ends its call (failed stays marked), a repeated call counts once, thoughts by headline, no outputs', () => {
  const { h, chat } = setup();
  const row = h.chats.beginAgentMessage(chat.id, 'ag_tom', 'run_s', { live: { steps: [], more: 0, startedAt: 0 } });
  for (let n = 1; n <= 7; n++) h.bus.emit('run.item', call('run_s', `c${n}`, `step ${n}`));
  h.bus.emit('run.item', call('run_s', 'c7', 'step 7')); // an engine repeating its call
  h.bus.emit('run.item', item('run_s', 'tool_result', { callId: 'c6', ok: true, output: 'SECRET OUTPUT', preview: 'SECRET OUTPUT' }));
  h.bus.emit('run.item', item('run_s', 'tool_result', { callId: 'c7', ok: false, output: 'boom' }));
  const thought = item('run_s', 'reasoning', { summary: '**Checking the plan**', live: true });
  h.bus.emit('run.item', thought);
  h.bus.emit('run.item', { ...thought, data: { summary: '**Checking the plan**\n\nDone thinking', live: false } }); // its update
  h.bus.emit('run.item', item('run_s', 'note', { text: 'An update', commentary: true }, 'Update'));
  h.bus.emit('run.item', item('run_s', 'plan', { steps: [{ text: 'a', status: 'done' }] }));
  const live = h.chats.message(row.id)!.meta.live!;
  assert.equal(live.more, 2, 'seven calls and a thought: two earlier');
  assert.deepEqual(live.steps.map((step) => step.target), ['step 3', 'step 4', 'step 5', 'step 6', 'step 7', 'Checking the plan']);
  assert.deepEqual(live.steps.slice(-3), [
    { kind: 'command', verb: 'Ran', active: 'Running', target: 'step 6' },
    { kind: 'command', verb: 'Ran', active: 'Running', target: 'step 7', failed: true },
    { kind: 'plan', verb: 'Thought', active: 'Thinking', target: 'Checking the plan', thought: true },
  ]);
  assert.equal(live.steps[0].running, true, 'no result yet: still running');
  assert.ok(!JSON.stringify(h.chats.message(row.id)!.meta).includes('SECRET'), 'never an output');
  h.bus.emit('run.item', call('run_other', 'x', 'elsewhere')); // a run without a row here
  assert.equal(h.chats.message(row.id)!.meta.live!.more, 2);
});

test('step values: a journaled engine step wins, our calls get their label, a thought without words is no line', () => {
  assert.deepEqual(itemStep(item('r', 'tool_call', { step: { kind: 'read', verb: 'Read', active: 'Reading', target: 'src/app.ts' } }, 'Read')),
    { kind: 'read', verb: 'Read', active: 'Reading', target: 'src/app.ts' });
  assert.deepEqual(itemStep(item('r', 'tool_call', { args: '{"query":"open invoices"}' }, 'web_search')),
    { kind: 'web', verb: 'Searched the web', active: 'Searching the web', target: '“open invoices”' });
  assert.equal(itemStep(item('r', 'tool_call', { args: JSON.stringify({ command: 'x'.repeat(300) }) }, 'shell')).target.length, 100, 'a short target');
  assert.equal(thoughtStep(item('r', 'reasoning', { summary: '' })), undefined);
  const steps: string[] = [];
  applyItem({ step: (_run, key) => { steps.push(key); } }, item('r', 'tool_result', { ok: true }));
  assert.deepEqual(steps, [], 'a result without a call id changes nothing');
});

test('activity: note, model and effort of the run reach its row; a split lane does not', () => {
  const { h, chat } = setup();
  const row = h.chats.beginAgentMessage(chat.id, 'ag_tom', 'run_a', { live: { steps: [], more: 0, startedAt: 0, model: 'Opus 5.5', effort: 'high' } });
  h.bus.emit('agent.activity', { active: [
    { agentId: 'ag_tom', runId: 'run_a', conversationId: chat.id, note: 'waiting for approval', modelName: 'GPT-5.5', effort: 'medium', startedAt: 0 },
    { agentId: 'ag_tom', runId: 'run_a', conversationId: chat.id, note: 'split', startedAt: 0, split: { id: 's', groupId: 'g', idx: 1, of: 2, parentRunId: 'run_a', title: 'x' } },
  ] });
  const live = h.chats.message(row.id)!.meta.live!;
  assert.deepEqual([live.note, live.model, live.effort], ['waiting for approval', 'GPT-5.5', 'medium'], 'after a failover too');
});

test('finish: meta.live goes, ms (time worked) and lines (every step, the newest 60) stay with the steps count', () => {
  const { h, chat } = setup();
  const row = h.chats.beginAgentMessage(chat.id, 'ag_tom', 'run_f', { model: 'Opus 5.5', live: { steps: [], more: 0, startedAt: h.clock.now() } });
  for (let n = 1; n <= 64; n++) h.bus.emit('run.item', call('run_f', `c${n}`, `step ${n}`));
  h.bus.emit('run.item', item('run_f', 'tool_result', { callId: 'c64', ok: true }));
  h.clock.advance(41_000);
  const done = h.chats.finishAgentMessage(row.id, { body: 'Done', state: 'final', meta: { steps: 64 } });
  assert.equal(done.meta.live, undefined);
  assert.deepEqual([done.meta.ms, done.meta.steps, done.meta.lines?.length], [41_000, 64, 60]);
  assert.deepEqual([done.meta.lines![0].target, done.meta.lines!.at(-1)], ['step 5', { kind: 'command', verb: 'Ran', active: 'Running', target: 'step 64' }]);
  assert.deepEqual(h.chats.message(row.id)!.meta.lines, done.meta.lines, 'stored with the row');
});

test('silent row: it shows the work (working, no preview, no text, quiet seq); failed or stopped it goes, posted it moves to the end', () => {
  const { h, chat } = setup();
  h.chats.send({ conversationId: chat.id, authorId: 'human', body: 'Hello Tom' });
  const before = h.chats.get(chat.id)!;
  h.clock.advance(5_000);
  const row = h.chats.beginAgentMessage(chat.id, 'ag_tom', 'run_q', { live: { steps: [], more: 0, startedAt: 0 } }, { silent: true });
  h.chats.appendDelta(row.id, 'Thinking out loud');
  h.bus.emit('run.item', call('run_q', 'c1', 'npm test'));
  const summary = h.chats.summary(chat.id);
  assert.deepEqual([row.silent, summary.working, summary.lastPreview?.text], [true, ['ag_tom'], 'Hello Tom']);
  assert.deepEqual([h.chats.message(row.id)!.body, h.chats.message(row.id)!.meta.live?.steps.length], ['', 1], 'its work, never its internal text');
  assert.deepEqual([summary.lastMessageAt, summary.updatedAt], [before.lastMessageAt, before.updatedAt], 'the chat keeps its place in the list');
  const removed: string[] = [];
  h.bus.on('message.removed', ({ id }) => removed.push(id));
  h.chats.finishAgentMessage(row.id, { body: '', state: 'failed', meta: { error: 'Crashed' } }); // an executor crash (dispatch-settle)
  assert.deepEqual([removed, h.chats.message(row.id)], [[row.id], undefined], 'nothing was posted: the row goes');
  assert.equal(h.chats.summary(chat.id).working.length, 0);
  const loud = h.chats.beginAgentMessage(chat.id, 'ag_tom', 'run_p', {}, { silent: true });
  h.clock.advance(1_000);
  const posted = h.chats.finishAgentMessage(loud.id, { body: 'Posted after all', state: 'final', silent: false });
  assert.equal(posted.silent, false, 'a posted answer names its level');
  assert.ok(posted.seq > loud.seq, 'posted, it takes a new seq at the end');
  const after = h.chats.summary(chat.id);
  assert.deepEqual([after.lastMessageAt, after.lastPreview?.text], [h.clock.now(), 'Posted after all'], 'and moves the chat up like any post');
});

test('preview: a row that still streams previews no text (the list says who works), its finished answer does', () => {
  const { h, chat } = setup();
  const row = h.chats.beginAgentMessage(chat.id, 'ag_tom', 'run_v', { live: { steps: [], more: 0, startedAt: 0 } });
  h.chats.appendDelta(row.id, 'Let me check the half written');
  assert.equal(h.chats.message(row.id)!.body, 'Let me check the half written');
  assert.deepEqual([h.chats.summary(chat.id).lastPreview?.text, h.chats.summary(chat.id).working], ['', ['ag_tom']]);
  h.chats.finishAgentMessage(row.id, { body: 'Checked: all good', state: 'final' });
  assert.equal(h.chats.summary(chat.id).lastPreview?.text, 'Checked: all good');
});

test('a failed end that hands back the stored text keeps the newest text this PC still held back', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { h, chat } = setup();
  const chats = new ChatServiceImpl(h.services, { liveGapMs: 500 });
  try {
    const row = chats.beginAgentMessage(chat.id, 'ag_tom', 'run_c');
    chats.appendDelta(row.id, 'First part');
    chats.appendDelta(row.id, ' and the rest');
    const stored = chats.message(row.id)!;
    assert.equal(stored.body, 'First part', 'the rest waits for the gap');
    const ended = chats.finishAgentMessage(row.id, { body: stored.body, state: 'failed', meta: { error: 'Crashed' } });
    assert.deepEqual([ended.state, ended.body, chats.message(row.id)!.body], ['failed', 'First part and the rest', 'First part and the rest']);
    const other = chats.beginAgentMessage(chat.id, 'ag_tom', 'run_d');
    chats.appendDelta(other.id, 'Raw [[silent]] text');
    mock.timers.tick(500);
    chats.appendDelta(other.id, ' more');
    assert.equal(chats.finishAgentMessage(other.id, { body: 'Cleaned text', state: 'stopped' }).body, 'Cleaned text', 'a finish with its own text keeps it');
  } finally {
    chats.dispose();
    mock.timers.reset();
  }
});
