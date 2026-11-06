// B-057 C – the fake engine's native fork (engines/fake-fork.ts): caps.fork, fork() answers fake-fork-<n> (generation 1)
// and records its inputs; a forked session's turn is an ordinary fake turn – the fake keeps no history, so a split's
// worker turn without a directive answers "Echo: <its new input>" (its part note first: "Your part #k of N – title …"),
// and its directives run like any turn's. The split e2e test relies on that answer.
// Owns: these assertions only. Never: real engines, network or processes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeEngine } from '../../../src/runtime/engines/fake.ts';
import type { EngineForkInput, EngineTurnInput } from '../../../src/runtime/engines/types.ts';
import type { ToolOutput } from '../../../src/runtime/tools/types.ts';
import { account } from '../models/harness.ts';

const forkInput = (parentRef: string): EngineForkInput => ({ runId: 'run_w1', agentId: 'ag_ada', account: account('acc_1', 'codex'), parentRef, cwd: '/ws', model: 'fake-1' });

function turn(engine: FakeEngine, ref: string, text: string) {
  const calls: string[] = [];
  const result = engine.run({
    runId: 'run_w1', agentId: 'ag_ada', input: [{ type: 'text', text }], system: { stable: 'STABLE', volatile: 'You are split #2 of 3.' },
    session: { ref, generation: 1 }, signal: AbortSignal.timeout(5000), onEvent: () => {},
    callTool: async (name: string): Promise<ToolOutput> => { calls.push(name); return { content: [{ type: 'text', text: 'ok' }] }; },
  } as unknown as EngineTurnInput);
  return { result, calls };
}

test('the fake engine forks: fake-fork-<n>, generation 1, inputs recorded oldest first', async () => {
  const engine = new FakeEngine();
  assert.equal(engine.caps.fork, true);
  assert.deepEqual(await engine.fork(forkInput('fake-session-1')), { ref: 'fake-fork-1', generation: 1 });
  assert.deepEqual(await engine.fork(forkInput('fake-session-1')), { ref: 'fake-fork-2', generation: 1 });
  assert.deepEqual(engine.fork.calls.map((call) => call.parentRef), ['fake-session-1', 'fake-session-1']);
  assert.equal(engine.turns.length, 0, 'a fork runs no turn');
});

test("a forked session's turn echoes its new input (the part note) and keeps the fork's ref; directives run as usual", async () => {
  const engine = new FakeEngine();
  const { ref } = await engine.fork(forkInput('fake-session-1'));
  const part = 'Your part #2 of 3 – Audit b.ts\nCheck b.ts for unused exports.\nReturn: the findings';
  const plain = await turn(engine, ref, part).result;
  assert.equal(plain.stop, 'done');
  assert.equal(plain.text, `Echo: ${part}`);
  assert.deepEqual(plain.session, { ref: 'fake-fork-1', generation: 1 });

  const other = await engine.fork(forkInput('fake-session-1'));
  const directed = turn(engine, other.ref, 'Your part #3 of 3 – Read c.ts\n[[tool:files.read {"path":"c.ts"}]]');
  const result = await directed.result;
  assert.deepEqual(directed.calls, ['files.read']);
  assert.equal(result.text, 'Echo: Your part #3 of 3 – Read c.ts\n\nfiles.read → ok');
});
