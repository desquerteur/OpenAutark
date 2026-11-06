// The demo engine's steering (21.10. 17:09, engines/fake.ts): text is accepted only while that run is
// in progress and its answer echoes it; before, after and for script turns nothing is accepted (so the
// dispatcher never marks a line read that no turn saw).
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeEngine } from '../../../src/runtime/engines/fake.ts';
import { turnInput } from './fakes.ts';

test('fake engine: steering only during the run, echoed in its answer', async () => {
  const engine = new FakeEngine();
  assert.equal(await engine.steer('run_1', 'early'), false, 'not running yet');
  let accepted: boolean | undefined;
  const { input } = turnInput({
    account: { id: 'acc_fake', provider: 'fake' }, model: 'fake-1',
    input: [{ type: 'text', text: 'Do it [[tool:tasks.create {"title":"X"}]]' }],
    callTool: async () => { accepted = await engine.steer('run_1', 'Also the blue logo'); return { content: [{ type: 'text', text: 'created' }] }; },
  });
  const result = await engine.run(input);
  assert.equal(accepted, true);
  assert.equal(result.stop, 'done');
  assert.match(result.text, /Echo: Also the blue logo/);
  assert.equal(await engine.steer('run_1', 'late'), false, 'the run ended');
  // A steered directive is new input: it runs in the same turn.
  const calls: string[] = [];
  let once = false;
  const second = turnInput({
    runId: 'run_3', account: { id: 'acc_fake', provider: 'fake' }, model: 'fake-1',
    input: [{ type: 'text', text: 'Start [[tool:tasks.create {"title":"A"}]]' }],
    callTool: async (_name: string, args: { title: string }) => {
      calls.push(args.title);
      if (!once) { once = true; await engine.steer('run_3', 'Lena: and B [[tool:tasks.create {"title":"B"}]]'); }
      return { content: [{ type: 'text', text: 'created' }] };
    },
  });
  const both = await engine.run(second.input);
  assert.deepEqual(calls, ['A', 'B']);
  assert.match(both.text, /Echo: Lena: and B$/m);
  const scripted = new FakeEngine({ script: async (turn) => { assert.equal(await scripted.steer(turn.runId, 'x'), false); return { text: 'ok', stop: 'done' }; } });
  assert.equal((await scripted.run(turnInput({ runId: 'run_2' }).input)).stop, 'done');
});
