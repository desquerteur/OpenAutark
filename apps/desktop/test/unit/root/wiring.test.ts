// B-044: the data folder watcher in the composition root – the stop step 'data folder' closes s.rootWatcher right
// after its first owner (the agent core) has left it, and before the database closes; 'settings file' unregisters settings.json
// before that. Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopSteps } from '../../../src/runtime/compose/lifecycle.ts';
import type { Core } from '../../../src/runtime/compose/services.ts';
import type { Network } from '../../../src/runtime/compose/network.ts';

test("stop order: 'data folder' right after 'agent core', before the database; it stops s.rootWatcher", async () => {
  const calls: string[] = [];
  const services = {
    agentCore: { stop: () => { calls.push('agentCore.stop'); } },
    rootWatcher: { stop: () => { calls.push('rootWatcher.stop'); } },
  };
  const steps = stopSteps({ services } as unknown as Core, new Proxy({}, { get: () => undefined }) as unknown as Network);
  const names = steps.map((step) => step.name);
  assert.equal(names[names.indexOf('agent core') + 1], 'data folder', names.join(', '));
  assert.ok(names.indexOf('data folder') < names.indexOf('database'));
  await steps.find((step) => step.name === 'agent core')!.run();
  await steps.find((step) => step.name === 'data folder')!.run();
  assert.deepEqual(calls, ['agentCore.stop', 'rootWatcher.stop']);
  await stopSteps({ services: {} } as unknown as Core, {} as unknown as Network).find((step) => step.name === 'data folder')!.run(); // not wired: nothing to stop
});

test("stop order: 'settings file' lets settings.json leave the watcher before the agent core and the watcher stop", async () => {
  const calls: string[] = [];
  const services = { settings: { close: () => { calls.push('settings.close'); } } };
  const steps = stopSteps({ services } as unknown as Core, new Proxy({}, { get: () => undefined }) as unknown as Network);
  const names = steps.map((step) => step.name);
  assert.ok(names.indexOf('settings file') < names.indexOf('agent core'), names.join(', '));
  await steps.find((step) => step.name === 'settings file')!.run();
  assert.deepEqual(calls, ['settings.close']);
  await stopSteps({ services: {} } as unknown as Core, {} as unknown as Network).find((step) => step.name === 'settings file')!.run(); // not wired: nothing to stop
});
