// D5: Codex reasoning summaries reach the run display (schema: the Codex app-server's generated JSON schema –
// ReasoningSummaryTextDelta/PartAdded {itemId, summaryIndex}, ReasoningThreadItem {summary[]},
// TurnStartParams.summary): deltas carry their item id, a later summary part is a section break,
// the completed reasoning item is the block's end with its authoritative text, and turn/start asks
// for summaries on an agent turn ('auto') and for none on a helper turn ('none').

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { reasoningText } from '../../../src/runtime/engines/codex/turn.ts';
import { fakeFinder, fakeSpawn, testSupervisor, turnInput, type FakeChild } from './fakes.ts';

/** A minimal app-server that records requests; `onTurn` scripts what follows turn/start. */
function appServer(onTurn: (child: FakeChild, threadId: string) => void) {
  const requests: any[] = [];
  const fake = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (msg.id !== undefined && !msg.method) return;
      if (msg.method) requests.push(msg);
      if (msg.method === 'initialize') child.send({ id: msg.id, result: { userAgent: 'fake' } });
      else if (msg.method === 'thread/start') child.send({ id: msg.id, result: { thread: { id: 'thr_1' } } });
      else if (msg.method === 'thread/unsubscribe') child.send({ id: msg.id, result: {} });
      else if (msg.method === 'turn/start') {
        child.send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
        onTurn(child, msg.params.threadId);
      } else if (msg.id !== undefined) child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
    };
  });
  return { ...fake, requests };
}

const engineFor = (spawn: any) => new CodexEngine({ supervisor: testSupervisor(spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/tmp', version: '0.2.0' });

test('codex reasoning: deltas carry the item id, a new summary part is a section break, the completed item ends the block with its text', async () => {
  const fake = appServer((child, threadId) => {
    const p = { threadId, turnId: 'turn_1' };
    child.send({ method: 'item/started', params: { ...p, item: { id: 'rs_1', type: 'reasoning', summary: [], content: [] } } });
    child.send({ method: 'item/reasoning/summaryPartAdded', params: { ...p, itemId: 'rs_1', summaryIndex: 0 } });
    child.send({ method: 'item/reasoning/summaryTextDelta', params: { ...p, itemId: 'rs_1', summaryIndex: 0, delta: '**Planning the search**\n\nLooking at ' } });
    child.send({ method: 'item/reasoning/summaryTextDelta', params: { ...p, itemId: 'rs_1', summaryIndex: 0, delta: 'the folders.' } });
    child.send({ method: 'item/reasoning/summaryPartAdded', params: { ...p, itemId: 'rs_1', summaryIndex: 1 } });
    child.send({ method: 'item/reasoning/summaryTextDelta', params: { ...p, itemId: 'rs_1', summaryIndex: 1, delta: '**Checking results**' } });
    child.send({ method: 'item/completed', params: { ...p, item: { id: 'rs_1', type: 'reasoning', summary: ['**Planning the search**\n\nLooking at the folders.', '**Checking results**'], content: [] } } });
    child.send({ method: 'item/completed', params: { ...p, item: { id: 'm1', type: 'agentMessage', text: 'Found it.' } } });
    child.send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn_1', status: 'completed' } } });
  });
  const engine = engineFor(fake.spawn);
  const { input, events } = turnInput();
  const result = await engine.run(input);
  assert.equal(result.stop, 'done');
  assert.equal(result.text, 'Found it.');
  const thoughts = events.filter((event: any) => event.type === 'reasoning' || event.type === 'reasoning_end');
  assert.deepEqual(thoughts, [
    { type: 'reasoning', delta: '**Planning the search**\n\nLooking at ', id: 'rs_1' },
    { type: 'reasoning', delta: 'the folders.', id: 'rs_1' },
    { type: 'reasoning', delta: '\n\n', id: 'rs_1' },
    { type: 'reasoning', delta: '**Checking results**', id: 'rs_1' },
    { type: 'reasoning_end', id: 'rs_1', text: '**Planning the search**\n\nLooking at the folders.\n\n**Checking results**' },
  ]);
  const start = fake.requests.find((request) => request.method === 'turn/start');
  assert.equal(start.params.summary, 'auto', 'an agent turn asks for reasoning summaries');
  await engine.dispose();
});

test('codex reasoning: a completed item without summary parts ends the block without a text; a helper turn asks for no summary', async () => {
  const fake = appServer((child, threadId) => {
    const p = { threadId, turnId: 'turn_1' };
    child.send({ method: 'item/completed', params: { ...p, item: { id: 'rs_9', type: 'reasoning', summary: [], content: [] } } });
    child.send({ method: 'item/completed', params: { ...p, item: { id: 'm1', type: 'agentMessage', text: '{"ok":true}' } } });
    child.send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn_1', status: 'completed' } } });
  });
  const engine = engineFor(fake.spawn);
  const { input, events } = turnInput({ runId: 'run_h', agentId: 'system', tools: [] });
  const result = await engine.run(input);
  assert.equal(result.stop, 'done');
  assert.deepEqual(events.filter((event: any) => event.type === 'reasoning_end'), [{ type: 'reasoning_end', id: 'rs_9' }]);
  assert.equal(fake.requests.find((request) => request.method === 'turn/start').params.summary, 'none', 'a helper turn pays for no summary');
  await engine.dispose();
});

test('codex reasoning: the authoritative text joins non-empty summary parts', () => {
  assert.deepEqual(reasoningText(['A', '', '  ', 'B']), { text: 'A\n\nB' });
  assert.deepEqual(reasoningText([]), {});
  assert.deepEqual(reasoningText(undefined), {});
});
