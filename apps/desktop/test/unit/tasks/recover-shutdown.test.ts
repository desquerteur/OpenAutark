// Restart recovery after a graceful stop and where the note lands (RC1): a quit or an update
// install aborts running turns through dispatcher.stop(), which names them in the journal before
// each turn closes itself 'interrupted'; the next start names their unknown effects exactly like
// a crash's (wake note, quiet line, "Did this happen?" for a spend) – once. The effects of a
// task's own runs reach the first resumed turn: a wake due now in the task's group, while a
// planned backoff or re-check keeps its time.
// Owns: these assertions only. Never: a real engine, process or timer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from '../chat/harness.ts';
import { Journal, recordShutdownRuns } from '../../../src/runtime/runs/journal.ts';
import { groupWakes } from '../../../src/runtime/agents/dispatch-groups.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { flush, setup as dispatcherSetup } from '../dispatcher/fakes.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';

const MIN = 60_000;

function setup() {
  const h = harness();
  const runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  Object.assign(h.services, { runs, secrets: { redact: (text: string) => text }, settings: { get: () => ({ profile: { timezone: 'UTC' } }) } });
  const ada = h.org.add(agent('ag_ada', 'Ada'));
  const chat = h.chats.create({ agentIds: [ada.id], createdBy: 'human' });
  const task = h.tasks.create({ conversationId: chat.id, title: 'Buy the domain', assigneeKind: 'agent', assigneeId: ada.id, createdBy: 'human' });
  h.tasks.claim(task.id, ada.id);
  return { ...h, runs, ada, chat, task, services: h.services as RuntimeServices };
}

test('dispatcher.stop() names the turns it cuts off; start() clears the list (a cancelled restart)', async () => {
  const h = dispatcherSetup();
  h.org.add(agent('ag_tom', 'Tom'));
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  const listed = () => new KvRepo(h.db).get<string[]>('system', 'shutdownRuns');
  h.dispatcher.start();
  h.chats.send({ conversationId: chat.id, body: 'Pay the invoice', authorId: 'human' });
  await flush();
  const call = h.executor.last();
  await h.dispatcher.stop();
  assert.equal(call.request.signal.aborted, true);
  assert.deepEqual(listed(), [call.request.runId]);
  await h.dispatcher.stop(); // the quit after an update drain: nothing runs any more, the list stays
  assert.deepEqual(listed(), [call.request.runId]);
  h.dispatcher.start();
  assert.equal(listed(), undefined);
  await h.dispatcher.stop();
});

