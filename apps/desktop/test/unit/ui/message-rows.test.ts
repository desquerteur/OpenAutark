// The message list's rows (src/ui/chat/message-rows.ts): consecutive status lines form one burst,
// and a jump (C4) to a line of a collapsed burst lands on its newest line the person sees –
// agents' edit and delete notices (C6) are hidden in the burst, so they are never the target. A call is one
// bubble at its row: the rows its lines name fold into it and show there in full (callEntries), every other row – a later
// answer too – stays a row.
// Owns: these assertions only. Never: renders (MessageList.tsx looks the line up in the DOM).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Message } from '../../../src/shared/model/chat.ts';
import { callLength, type CallRecord } from '../../../src/shared/model/call.ts';
import { burstLineFor, callEntries, groupRows, isLiveWork, liveRunIds, liveStart, liveWork, rowHas, runLineIds } from '../../../src/ui/chat/message-rows.ts';

const text = (seq: number): Message => ({
  id: `msg_${seq}`, conversationId: 'cv_rows', seq, authorId: 'human', authorKind: 'human', kind: 'text', body: `#${seq}`, attachments: [], mentions: [],
  priority: 'normal', state: 'final', silent: false, meta: {}, createdAt: seq,
}) as Message;
const status = (seq: number, details: Record<string, unknown> = {}): Message => ({
  ...text(seq), authorId: 'system', authorKind: 'system', kind: 'status', silent: true, body: `line ${seq}`,
  meta: { status: { type: 'note', text: `line ${seq}`, details } },
}) as Message;
/** An agents-only notice as chat/message-edits.ts writes it. */
const notice = (seq: number, edited: number): Message => status(seq, { edited: `msg_${edited}`, seq: edited });

test('consecutive status lines form one burst between messages', () => {
  const rows = groupRows([text(1), status(2), status(3), text(4), status(5)]);
  assert.deepEqual(rows.map((row) => (row.kind === 'message' ? row.message.id : row.messages.map((message) => message.id).join('+'))),
    ['msg_1', 'msg_2+msg_3', 'msg_4', 'msg_5']);
  assert.equal(rowHas(rows[1], 'msg_3'), true);
  assert.equal(rowHas(rows[0], 'msg_3'), false);
});

test('a jump into a burst whose newest line is an edit notice lands on the newest line the person sees', () => {
  const rows = groupRows([text(1), status(2), status(3), notice(4, 1), text(5)]);
  assert.equal(burstLineFor(rows, 'msg_2'), 'msg_3', 'the hidden notice is skipped');
  assert.equal(burstLineFor(rows, 'msg_4'), 'msg_3', 'a link to the notice itself lands on the burst too');
  assert.equal(burstLineFor(rows, 'msg_1'), undefined, 'a message outside any burst has its own element');
  assert.equal(burstLineFor(rows, 'msg_9'), undefined, 'not in the rows');
});

test('a burst of notices only shows nothing to land on', () => {
  const rows = groupRows([text(1), notice(2, 1), notice(3, 1)]);
  assert.equal(burstLineFor(rows, 'msg_2'), undefined);
});

/** A call's row (runtime/calls/call-log.ts) whose lines name these messages. */
const callRow = (seq: number, id: string, lines: number[], endedAt?: number): Message => {
  const call: CallRecord = { id, participant: 'device:pc', name: 'laptop', startedAt: seq, ...(endedAt ? { endedAt } : {}), lines: lines.map((line) => ({ at: line, from: 'device:pc', name: 'Gerd', text: `#${line}`, messageId: `msg_${line}` })) };
  return { ...status(seq), meta: { status: { type: 'note', text: 'Call from laptop' }, call } } as Message;
};
const said = (seq: number, id: string): Message => ({ ...text(seq), meta: { call: { id, participant: 'device:pc', name: 'laptop' } } });

test('a call is one bubble at its row: the rows its lines name fold into it, wherever they stand', () => {
  const late = agentMsg(7, { meta: { call: { id: 'call_a', participant: 'agent:ag_tom', name: 'Tom' } } }); // after the call ended: not in its lines
  const rows = groupRows([said(1, 'call_a'), callRow(2, 'call_a', [1, 3, 5], 6), text(3), status(4), agentMsg(5), status(6), late]);
  assert.deepEqual(rows.map((row) => (row.kind === 'message' ? row.message.id : row.kind)), ['call', 'status', 'msg_7'], 'the status lines around a folded line are one burst');
  assert.deepEqual(rows[0].kind === 'call' && [rows[0].callId, rows[0].messages.map((message) => message.id)], ['call_a', ['msg_2', 'msg_1', 'msg_3', 'msg_5']], 'the row first, then its lines – one synced before the row too');
  assert.equal(burstLineFor(rows, 'msg_5'), 'msg_2', 'a jump to a line lands on the bubble');
  assert.equal(rowHas(rows[0], 'msg_3'), true);
});

test('the bubble shows a folded row as itself – in full, with its files – and a line whose row is not loaded by its kept words', () => {
  const long = 'x'.repeat(3000);
  const answer = agentMsg(5, { body: long, attachments: [{ fileId: 'f_cut', name: 'cut.mp4', mime: 'video/mp4', size: 9 }] });
  const row = callRow(2, 'call_a', [1, 5], 6); // line 1's row is not loaded on this device
  const [bubble] = groupRows([row, answer]);
  assert.equal(bubble.kind, 'call');
  const entries = callEntries(bubble.kind === 'call' ? bubble.messages : []);
  assert.deepEqual(entries.map((entry) => [entry.line.messageId, entry.message?.id]), [['msg_1', undefined], ['msg_5', 'msg_5']], 'in the lines\' order');
  assert.equal(entries[0].line.text, '#1', 'the words the call row keeps');
  assert.equal(entries[1].message?.body.length, 3000, 'the whole answer, not the capped line');
  assert.equal(entries[1].message?.attachments[0].name, 'cut.mp4');
  assert.deepEqual(callEntries([text(9)]), [], 'no call row: nothing');
  const view = readFileSync(new URL('../../../src/ui/chat/call/CallTranscript.tsx', import.meta.url), 'utf8'); // a .tsx file does not load here
  assert.match(view, /callEntries\(props\.messages\)/);
  assert.match(view, /message\s*\?\s*<MessageItem key=\{message\.id\} message=\{message\}/, 'a loaded row renders as its message');
});

test('lines of a call whose row is not loaded, or that its lines do not name, stay rows', () => {
  const rows = groupRows([said(1, 'call_a'), said(2, 'call_a'), callRow(3, 'call_b', []), said(4, 'call_b')]);
  assert.deepEqual(rows.map((row) => (row.kind === 'message' ? row.message.id : row.kind)), ['msg_1', 'msg_2', 'call', 'msg_4']);
  assert.deepEqual(rows[2].kind === 'call' && rows[2].messages.map((message) => message.id), ['msg_3']);
});

test('how long a call ran', () => {
  assert.equal(callLength(282_000), '4:42');
  assert.equal(callLength(59_400), '0:59');
  assert.equal(callLength(3_725_000), '1:02:05');
  assert.equal(callLength(-5), '0:00');
});

// D5: live work leaves the seq rows (the live block at the bottom shows it), every live run of the
// chat is listed by start, and one message per finished run carries its "Worked … · N steps" line.
// Root cause fixed: the live block sat at the turn's start seq, above approvals and cards it caused.
const agentMsg = (seq: number, patch: Partial<Message> = {}): Message => ({ ...text(seq), authorId: 'ag_tom', authorKind: 'agent', ...patch }) as Message;

test('a streaming run answer is no row – also one answering a call; finished answers stay rows', () => {
  const live = agentMsg(2, { state: 'streaming', runId: 'run_1', body: '' });
  const call = agentMsg(4, { state: 'streaming', runId: 'run_2', meta: { call: { id: 'call_a', participant: 'agent:ag_tom', name: 'Tom' } } });
  assert.equal(isLiveWork(live), true);
  assert.equal(isLiveWork(call), true, 'its live block shows the work like any other');
  const rows = groupRows([text(1), live, status(3), call, agentMsg(5, { runId: 'run_0' })]);
  assert.deepEqual(rows.map((row) => (row.kind === 'message' ? row.message.id : row.kind)), ['msg_1', 'status', 'msg_5']);
});

test('B-075 live work: the chat\'s streaming rows, one per run, ordered by the start their live values name', () => {
  const answer = agentMsg(2, { state: 'streaming', runId: 'run_b', body: 'Hel', createdAt: 200, meta: { live: { steps: [], more: 0, startedAt: 150 } } });
  const quiet = agentMsg(3, { state: 'streaming', runId: 'run_a', silent: true, createdAt: 300, meta: { live: { steps: [], more: 0, startedAt: 100 } } });
  const old = agentMsg(4, { state: 'streaming', runId: 'run_c', createdAt: 120 }); // a row without live values: its creation
  assert.deepEqual(liveWork([text(1), answer, quiet, old]).map((message) => message.id), ['msg_3', 'msg_4', 'msg_2']);
  assert.equal(liveStart(old), 120);
  assert.deepEqual([...liveRunIds([text(1), answer, quiet, agentMsg(5, { runId: 'run_d' })])].sort(), ['run_a', 'run_b']);
  // The answer arrived: it is that answer, no second block.
  const done = agentMsg(5, { runId: 'run_b', meta: { model: 'GPT-6' } });
  assert.deepEqual(liveWork([text(1), answer, done]), [], 'its answer, not a second block');
});

test('one line per run: on its answer (meta.model, or a failed/stopped end), else on its last post once the run ended', () => {
  const post = agentMsg(2, { runId: 'run_1', body: 'Status: halfway' }); // chat.send during the run
  const answer = agentMsg(5, { runId: 'run_1', meta: { model: 'GPT-6' } }); // moved to the end (D4)
  const internal = agentMsg(6, { runId: 'run_2', body: 'Posted by chat.send' });
  const failed = agentMsg(7, { runId: 'run_3', state: 'failed' });
  const stillLive = agentMsg(8, { runId: 'run_4', body: 'A post while it works' });
  const ids = runLineIds([text(1), post, status(3), agentMsg(4), answer, internal, failed, stillLive], new Set(['run_4', 'run_1']));
  assert.deepEqual([...ids].sort(), ['msg_5', 'msg_6', 'msg_7'], 'the answer even while the run still reports activity; no line on a live run\'s post');
});
