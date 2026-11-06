// Codex helper turns (audit 23.10.): a runtime helper turn – no tools, no MCP hub, no session (decision
// fallback, verifier, compaction, widget fills over decision/engine-runner.ts) – runs on an ephemeral
// thread (`thread/start` ephemeral: true, so nothing lands in the account's Codex history, like Claude
// Code's --no-session-persistence), returns no session and is unloaded after the turn (thread/unsubscribe).
// An agent turn (tools offered) keeps its persistent, resumable thread.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../../../src/runtime/engines/codex/engine.ts';
import { HELPER_REQUESTS } from '../../../src/runtime/engines/codex/turn.ts';
import { fakeSpawn, fakeFinder, testSupervisor, turnInput, tick } from './fakes.ts';

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await tick();
}

/** A scripted app-server whose turns answer "ok" and complete. */
function appServer() {
  const requests: any[] = [];
  let threads = 0;
  const { spawn } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (!msg.method) return;
      requests.push(msg);
      switch (msg.method) {
        case 'initialize': child.send({ id: msg.id, result: { userAgent: 'fake' } }); break;
        case 'thread/start': child.send({ id: msg.id, result: { thread: { id: `thr_${++threads}` } } }); break;
        case 'thread/unsubscribe': child.send({ id: msg.id, result: { status: 'unsubscribed' } }); break;
        case 'turn/start': {
          const threadId = msg.params.threadId;
          child.send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
          child.send({ method: 'item/completed', params: { threadId, turnId: 'turn_1', item: { id: 'm1', type: 'agentMessage', text: '{"ok":true}' } } });
          child.send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn_1', status: 'completed' } } });
          break;
        }
        default: if (msg.id !== undefined) child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
      }
    };
  });
  return { spawn, requests };
}

test('codex helper turn: ephemeral thread, no session, unloaded afterwards; an agent turn keeps its thread', async () => {
  const fake = appServer();
  const engine = new CodexEngine({ supervisor: testSupervisor(fake.spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/tmp', version: '0.2.0' });

  const helper = await engine.run(turnInput({ runId: 'run_h', agentId: 'system', tools: [], outputSchema: { type: 'object' } }).input);
  assert.equal(helper.stop, 'done');
  assert.deepEqual(helper.structured, { ok: true });
  assert.equal(helper.session, undefined, 'a helper turn is never resumed');
  const helperStart = fake.requests.find((r) => r.method === 'thread/start');
  assert.equal(helperStart.params.ephemeral, true, 'not written into the Codex history');
  await until(() => fake.requests.some((r) => r.method === 'thread/unsubscribe'));
  assert.deepEqual(fake.requests.find((r) => r.method === 'thread/unsubscribe').params, { threadId: 'thr_1' });

  const agent = await engine.run(turnInput({ runId: 'run_a' }).input);
  assert.deepEqual(agent.session && { ref: agent.session.ref, generation: agent.session.generation }, { ref: 'thr_2', generation: 1 });
  assert.equal(typeof agent.session?.turn, 'string', 'B-049 F7: an agent turn records its native turn id');
  const agentStart = fake.requests.filter((r) => r.method === 'thread/start')[1];
  assert.equal(agentStart.params.ephemeral, undefined, 'an agent thread stays persistent and resumable');
  assert.equal(fake.requests.filter((r) => r.method === 'thread/unsubscribe').length, 1, 'the agent thread stays loaded');
  await engine.dispose();
});

test('codex helper turn: a model that goes on request after request is cut, an agent turn is not', async () => {
  const requests: any[] = [];
  const { spawn } = fakeSpawn(({ child }) => {
    child.onLine = (msg) => {
      if (!msg.method) return;
      requests.push(msg);
      switch (msg.method) {
        case 'initialize': child.send({ id: msg.id, result: { userAgent: 'fake' } }); break;
        case 'thread/start': child.send({ id: msg.id, result: { thread: { id: 'thr_1' } } }); break;
        case 'thread/unsubscribe': child.send({ id: msg.id, result: { status: 'unsubscribed' } }); break;
        case 'turn/start': {
          const threadId = msg.params.threadId;
          child.send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
          for (let n = 0; n < HELPER_REQUESTS + 2; n++) child.send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId: 'turn_1', tokenUsage: { last: { inputTokens: 7000, outputTokens: 14, totalTokens: 7014 } } } });
          if (!msg.params.outputSchema) child.send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn_1', status: 'completed' } } });
          break;
        }
        case 'turn/interrupt':
          child.send({ id: msg.id, result: {} });
          child.send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: 'turn_1', status: 'interrupted' } } });
          break;
        default: if (msg.id !== undefined) child.send({ id: msg.id, error: { code: -32601, message: 'nope' } });
      }
    };
  });
  const engine = new CodexEngine({ supervisor: testSupervisor(spawn), finder: fakeFinder({ codex: '/bin/codex' }), cwd: '/tmp', version: '0.2.0' });
  const helper = await engine.run(turnInput({ runId: 'run_h', agentId: 'system', tools: [], outputSchema: { type: 'object' } }).input);
  assert.equal(helper.stop, 'interrupted');
  assert.equal(requests.filter((r) => r.method === 'turn/interrupt').length, 1);
  const agent = await engine.run(turnInput({ runId: 'run_a' }).input);
  assert.equal(agent.stop, 'done');
  assert.equal(requests.filter((r) => r.method === 'turn/interrupt').length, 1, 'an agent turn makes as many requests as its work needs');
  await engine.dispose();
});
