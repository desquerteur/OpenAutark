// B-059 dispatch track: the low-disk gate (#20,
// system/disk-gate.ts), a crashed executor's settle (#17) and the last-resort release of a turn that ignores its
// abort (#18, agents/dispatch-settle.ts) – on the dispatcher harness (real chats, wakes and scheduler on fake timers).
// Owns: these assertions only. Never: real engines, network or disks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from '../chat/harness.ts';
import { flush, openWakes, setup } from './fakes.ts';
import { DispatcherImpl } from '../../../src/runtime/agents/dispatcher.ts';
import { abortTurn, runEntry } from '../../../src/runtime/agents/dispatch-runs.ts';
import { abandonRun, RELEASED_NOTE } from '../../../src/runtime/agents/dispatch-settle.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { findOrCreateDirect } from '../../../src/runtime/chat/direct.ts';
import type { TurnOutcome, TurnRequest } from '../../../src/runtime/agents/turn-types.ts';
import type { Paths } from '../../../src/runtime/contracts.ts';
import type { Run } from '../../../src/shared/model/runs.ts';

const MINUTE = 60_000;
const MB = 1024 ** 2;

/** `n` finished turns of Tom that reached a model, one a minute from `from` on (newest first, like the journal). */
function busyRuns(n: number, from: number): Run[] {
  return Array.from({ length: n }, (_, i): Run => ({ id: `run_old_${i}`, agentId: 'ag_tom', trigger: 'task', engine: 'codex', status: 'done', startedAt: from + i * MINUTE })).reverse();
}

/** The dispatcher harness with its own executor and options (the standard one is replaced, never started). */
function rig(options: { execute?: (request: TurnRequest) => Promise<TurnOutcome>; freeBytes?: (dir: string) => number | undefined; releaseMs?: number } = {}) {
  const h = setup();
  const executor = options.execute ? { execute: options.execute } : h.executor;
  const dispatcher = new DispatcherImpl({
    services: () => h.services, executor, supervisor: { admit: async () => () => {} }, maxConcurrent: 2,
    ...(options.freeBytes ? { freeBytes: options.freeBytes } : {}), ...(options.releaseMs ? { releaseMs: options.releaseMs } : {}),
  });
  h.services.dispatcher = dispatcher;
  return { ...h, dispatcher };
}

test('B-059 #20: under 1 GB free no turn starts – the wakes stay queued, one notice; freed space resumes every waiting agent', async () => {
  let free = 500 * MB;
  const h = rig({ freeBytes: () => free });
  Object.assign(h.services, { paths: { data: 'C:/data' } as Paths });
  h.org.add(agent('ag_tom', 'Tom'));
  h.org.add(agent('ag_lea', 'Lea'));
  const a = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const b = h.chats.create({ agentIds: ['ag_lea'], createdBy: 'human' });
  h.dispatcher.start();
  h.chats.send({ conversationId: a.id, body: 'build it', authorId: 'human' });
  await flush();
  assert.equal(h.executor.calls.length, 0);
  assert.deepEqual(openWakes(h.db).map((row) => [row.agent_id, row.claimed_at]), [['ag_tom', null]], 'unclaimed, not held');
  const blockers = () => h.notified.filter((note) => note.kind === 'blocker');
  assert.equal(blockers().length, 1);
  assert.equal(blockers()[0]!.title, 'Disk almost full – agent work paused');
  assert.match(blockers()[0]!.body, /^500 MB free\./);

  h.chats.send({ conversationId: b.id, body: 'and you', authorId: 'human' });
  await flush();
  assert.equal(h.executor.calls.length, 0);
  assert.equal(blockers().length, 1, 'one notice per low phase');

  free = 1.2 * 1024 * MB; // above 1 GB, below 1.5 GB: still low
  h.clock.advance(61_000);
  h.chats.send({ conversationId: a.id, body: 'still there?', authorId: 'human' });
  await flush();
  assert.equal(h.executor.calls.length, 0);

  free = 2 * 1024 * MB;
  h.clock.advance(61_000);
  h.chats.send({ conversationId: a.id, body: 'go', authorId: 'human' });
  await flush();
  assert.deepEqual(h.executor.calls.map((call) => call.request.agentId).sort(), ['ag_lea', 'ag_tom'], 'the next admission resumes the whole queue');
  assert.equal(blockers().length, 1);
});

test('B-059 #20: a volume that cannot be read never gates', async () => {
  const h = rig({ freeBytes: () => undefined });
  Object.assign(h.services, { paths: { data: '//share/odd' } as Paths });
  h.org.add(agent('ag_tom', 'Tom'));
  const a = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.dispatcher.start();
  h.chats.send({ conversationId: a.id, body: 'go', authorId: 'human' });
  await flush();
  assert.equal(h.executor.calls.length, 1);
});

test('B-059 #17: an executor that throws after its run started fails its streaming bubble and gives its task the after-turn handling', async () => {
  const after: Array<Record<string, unknown>> = [];
  let chat = '';
  const h = rig({
    execute: async (request) => {
      h.runStatus.set(request.runId, 'running');
      h.chats.beginAgentMessage(chat, 'ag_tom', request.runId);
      throw new Error('disk I/O error');
    },
  });
  h.org.add(agent('ag_tom', 'Tom'));
  chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' }).id;
  Object.assign(h.ownership, { afterTurn: (input: Record<string, unknown>) => { after.push(input); } });
  h.dispatcher.start();
  h.wakes.wake({ agentId: 'ag_tom', reason: 'task', conversationId: chat, taskId: 'task_1' });
  await flush();
  const runId = h.finishedRuns[0]?.runId;
  assert.deepEqual(h.finishedRuns, [{ runId, status: 'failed' }]);
  assert.deepEqual(after, [{ agentId: 'ag_tom', taskId: 'task_1', runId, outcome: 'failed', progressed: false, note: 'The turn failed unexpectedly.' }]);
  const bubble = h.chats.messages(chat).find((message) => message.runId === runId)!;
  assert.equal(bubble.state, 'failed');
  assert.equal(bubble.meta.error, 'The turn failed unexpectedly.');
  assert.equal(openWakes(h.db).length, 0, 'the crashed turn is not re-run by the queue');
  assert.equal(h.org.get('ag_tom')!.status, 'idle');
});

test('B-059 #17: no second after-turn when the run was closed already, none after the person\'s Stop', async () => {
  const after: unknown[] = [];
  let mode: 'closed' | 'stopped' = 'closed';
  const h = rig({
    execute: (request) => new Promise((_, reject) => {
      if (mode === 'closed') { h.runStatus.set(request.runId, 'done'); reject(new Error('late bug')); return; }
      h.runStatus.set(request.runId, 'running');
      request.signal.addEventListener('abort', () => reject(new Error('cut')), { once: true });
    }),
  });
  h.org.add(agent('ag_tom', 'Tom'));
  Object.assign(h.ownership, { afterTurn: (input: unknown) => { after.push(input); } });
  h.dispatcher.start();
  h.wakes.wake({ agentId: 'ag_tom', reason: 'task', taskId: 'task_1' });
  await flush();
  assert.equal(after.length, 0, 'its own finish may have run afterTurn');
  mode = 'stopped';
  h.wakes.wake({ agentId: 'ag_tom', reason: 'task', taskId: 'task_2' });
  await flush();
  await h.dispatcher.interrupt('ag_tom');
  await flush();
  assert.equal(after.length, 0, 'a Stop is never turned into a retry');
});

test('B-059 #18: a turn that ignores its abort is released after the grace – slot and agent free, run closed, bubble stopped', async () => {
  const requests: TurnRequest[] = [];
  let chat = '';
  const h = rig({
    releaseMs: 20,
    execute: (request) => {
      requests.push(request);
      h.runStatus.set(request.runId, 'running');
      if (requests.length === 1) h.chats.beginAgentMessage(chat, 'ag_tom', request.runId);
      return new Promise(() => {}); // a tool that never settles and ignores the signal
    },
  });
  h.org.add(agent('ag_tom', 'Tom'));
  chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' }).id;
  h.dispatcher.start();
  h.chats.send({ conversationId: chat, body: 'build it', authorId: 'human' });
  await flush();
  assert.equal(requests.length, 1);
  const runId = requests[0]!.runId;
  void h.dispatcher.interrupt('ag_tom'); // the person's Stop
  await flush();
  assert.equal(h.dispatcher.activity().length, 1, 'still held within the grace');
  await new Promise((resolve) => setTimeout(resolve, 60));
  await flush();
  assert.equal(h.dispatcher.activity().length, 0, 'released');
  assert.equal(h.org.get('ag_tom')!.status, 'idle');
  assert.deepEqual(h.finishedRuns, [{ runId, status: 'interrupted' }]);
  assert.ok(h.runItems.some((item) => item.runId === runId && item.kind === 'note' && item.data.released === true && item.data.stopKind === 'human'));
  assert.equal(h.chats.messages(chat).find((message) => message.runId === runId)!.state, 'stopped');
  assert.equal(openWakes(h.db).length, 0, 'the Stop settled its wakes done');
  h.chats.send({ conversationId: chat, body: 'next', authorId: 'human' });
  await flush();
  assert.equal(requests.length, 2, 'the agent runs again');
});

