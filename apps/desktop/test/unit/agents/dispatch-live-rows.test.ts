// B-075 live rows in the dispatcher's settle and steering: a crashed or released run's row is found among the chat's
// live rows however much came after it (agents/dispatch-settle.ts endStreaming); a background run's silent row then
// goes, as nothing was posted. Steering passes a colleague's silent live row (it holds no text; its answer takes a new
// seq at the end) and still stops before a colleague's answer that is being written (agents/dispatch-steer.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../context/fixture.ts';
import { abandonRun, CRASH_NOTE, settleCrash } from '../../../src/runtime/agents/dispatch-settle.ts';
import type { RunEntry } from '../../../src/runtime/agents/dispatch-runs.ts';
import { steerInput } from '../../../src/runtime/agents/dispatch-steer.ts';

const LIVE = { live: { steps: [], more: 0, startedAt: 1 } };
const entry = (conversationId: string, runId: string, agentId: string) => ({
  runId, agentId, lane: agentId, conversationId, reason: 'message', wakeIds: [], attempts: 1, controller: new AbortController(),
  control: {}, note: '', startedAt: 0, settle: 'done',
}) as unknown as RunEntry;

test('a crashed run\'s row ends failed even with more than 50 lines after it; a background run\'s silent row goes', () => {
  const f = fixture();
  const chat = f.chats.create({ agentIds: [f.manager.id, f.vid.id], createdBy: 'human' });
  const row = f.chats.beginAgentMessage(chat.id, f.manager.id, 'run_main', LIVE);
  f.chats.appendDelta(row.id, 'Half an answer');
  for (let i = 0; i < 60; i++) f.chats.send({ conversationId: chat.id, body: `line ${i}`, authorId: 'human' });
  settleCrash(f.services, entry(chat.id, 'run_main', f.manager.id), false);
  const failed = f.chats.message(row.id)!;
  assert.deepEqual([failed.state, failed.body, failed.meta.error], ['failed', 'Half an answer', CRASH_NOTE]);

  const quiet = f.chats.beginAgentMessage(chat.id, f.vid.id, 'run_bg', LIVE, { silent: true });
  abandonRun(f.services, entry(chat.id, 'run_bg', f.vid.id));
  assert.equal(f.chats.message(quiet.id), undefined, 'nothing was posted: the live row goes');
  assert.ok(f.of('message.removed').some((message) => message.id === quiet.id));
  assert.equal(f.chats.summary(chat.id).live, undefined, 'nobody works any more');
});

test('steering passes a colleague\'s silent live row and stops before one whose answer is being written', () => {
  const f = fixture();
  const chat = f.chats.create({ agentIds: [f.manager.id, f.vid.id], createdBy: 'human' });
  const start = f.chats.send({ conversationId: chat.id, body: 'Start', authorId: 'human' });
  f.chats.beginAgentMessage(chat.id, f.manager.id, 'run_bg', LIVE, { silent: true });
  const urgent = f.chats.send({ conversationId: chat.id, body: 'Stop the render', authorId: 'human', priority: 'important' });
  const passed = steerInput(f.services, f.vid.id, chat.id, start.seq)!;
  assert.deepEqual([passed.text, passed.lastSeq, passed.lines], ['New messages in this chat while I am working:\n[11:00] Alex: (important) Stop the render', urgent.seq, 1]);

  const writing = f.chats.beginAgentMessage(chat.id, f.manager.id, 'run_main', LIVE);
  f.chats.send({ conversationId: chat.id, body: 'And the intro', authorId: 'human', priority: 'important' });
  const held = steerInput(f.services, f.vid.id, chat.id, urgent.seq);
  assert.equal(held, undefined, 'the answer being written comes later, complete – nothing is passed');
  assert.ok(writing.seq > urgent.seq);
});
