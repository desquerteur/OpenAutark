// B-057 S13 × B-059 #18 – a main-lane turn released after its abort (a tool ignored the signal): the split groups it
// created are settled right then (agents/dispatch-settle.ts abandonRun → afterParentTurn) – never started after the
// person's Stop, started after an urgent or shutdown cut – instead of waiting 'pending' until the hung work returns or
// the next boot. Fake services. Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abandonRun } from '../../../src/runtime/agents/dispatch-settle.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { RunEntry } from '../../../src/runtime/agents/dispatch-runs.ts';

function released(stopKind: 'human' | 'urgent' | 'shutdown') {
  const after: Array<{ runId: string; status: string }> = [];
  const services = {
    runs: { item: () => undefined, get: () => ({ id: 'run_main', status: 'running' }), finish: () => undefined, items: () => [] },
    splits: { afterParentTurn: (runId: string, status: string) => { after.push({ runId, status }); } },
    clock: { now: () => 1 }, log: { warn: () => {}, info: () => {} },
  } as unknown as RuntimeServices;
  abandonRun(services, { runId: 'run_main', agentId: 'ag_ava', control: { stopKind } } as unknown as RunEntry);
  return after;
}

test('the person\'s Stop of a turn that had to be released: its split groups never start; a cut lets them start', () => {
  assert.deepEqual(released('human'), [{ runId: 'run_main', status: 'stopped' }]);
  assert.deepEqual(released('urgent'), [{ runId: 'run_main', status: 'failed' }]);
  assert.deepEqual(released('shutdown'), [{ runId: 'run_main', status: 'failed' }]);
});
