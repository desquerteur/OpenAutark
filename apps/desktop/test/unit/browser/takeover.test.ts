// The person's takeover of an agent's own browser (browser/takeover.ts, view.ts): one flag – while on, every agent step
// answers that the person has it (the agent then waits); hand back wakes the agent in the chat and task of its last
// browser call (quietly with wake false); the browser closing wakes a waiting agent; password field values the person
// sent a form with go to the vault when it ends (a value the vault holds is skipped).
// Owns: these assertions only. Never: a real browser, vault or wake queue.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { keepPasswords, PERSON_USING, Takeovers, type TakeoverEnded } from '../../../src/runtime/browser/takeover.ts';
import { startBrowserView } from '../../../src/runtime/browser/view.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { cleanup, fakeBrowser, recordingBus, tick } from './view-fakes.ts';

after(cleanup);

test('one flag: refused while on (the agent waits), hand back ends it with the last use; a close ends it too', () => {
  const takeovers = new Takeovers(() => 5);
  const ended: TakeoverEnded[] = [];
  takeovers.onEnd((event) => ended.push(event));
  takeovers.guard('ag_1', { conversationId: 'ch_1', taskId: 'tk_1' });
  assert.equal(takeovers.start('ag_1'), true);
  assert.equal(takeovers.start('ag_1'), false, 'already on');
  assert.deepEqual(takeovers.state('ag_1'), { since: 5, waiting: false });
  assert.throws(() => takeovers.guard('ag_1'), (error: Error) => error.message === PERSON_USING);
  assert.equal(takeovers.state('ag_1')?.waiting, true);
  takeovers.keep('ag_1', 'shop.example.com', ['pw-1']);
  takeovers.keep('ag_2', 'shop.example.com', ['ignored']); // not taken over
  assert.equal(takeovers.end('ag_1'), true);
  assert.equal(takeovers.end('ag_1'), false);
  assert.deepEqual(ended, [{ agentId: 'ag_1', reason: 'hand_back', wake: true, context: { conversationId: 'ch_1', taskId: 'tk_1' }, passwords: [{ host: 'shop.example.com', value: 'pw-1' }] }]);
  takeovers.guard('ag_1'); // free again

  takeovers.start('ag_2');
  takeovers.forget('ag_2', 'closed');
  assert.equal(ended.at(-1)?.wake, false, 'a close the agent did not wait on wakes nobody');
  takeovers.start('ag_3');
  takeovers.forget('ag_3', 'shutdown');
  assert.equal(ended.length, 2, 'shutdown ends quietly');
});

test('the vault keeps the person\'s password once, as the agent\'s secret for that site', async () => {
  const saved: Array<Record<string, unknown>> = [];
  const services = {
    log: new MemoryLogger(),
    secrets: {
      redact: (text: string) => (text === 'known-pw' ? 'secret://s1' : text),
      holding: async (value: string) => (value === 'held-pw' ? ['s2'] : []),
      save: async (input: Record<string, unknown>) => { saved.push(input); return input; },
    },
  } as unknown as RuntimeServices;
  const kept = await keepPasswords(services, 'ag_1', [
    { host: 'login.shop.example.com', value: 'new-pw' }, { host: 'shop.example.com', value: 'known-pw' }, { host: 'shop.example.com', value: 'held-pw' },
  ]);
  assert.equal(kept, 1);
  assert.deepEqual(saved, [{ label: 'example.com password', kind: 'password', value: 'new-pw', source: 'example.com', createdBy: 'ag_1', description: 'Password the person entered on example.com while they had your browser.' }]);
});

test('the live view wires the end: hand back wakes the agent where it browsed, quietly with wake false; a sent password is kept', async () => {
  const { browser, contexts } = fakeBrowser();
  const woken: Array<Record<string, unknown>> = [];
  const saved: Array<Record<string, unknown>> = [];
  const services = {
    bus: recordingBus().bus, log: new MemoryLogger(), wakes: { wake: (request: Record<string, unknown>) => woken.push(request) },
    secrets: { redact: (text: string) => text, holding: async () => [], save: async (input: Record<string, unknown>) => { saved.push(input); return input; } },
  } as unknown as RuntimeServices;
  const view = startBrowserView(() => services, browser);
  await browser.open('ag_1', { url: 'https://shop.example.com/login', use: { conversationId: 'ch_1' } });
  const page = contexts[0].list[0] as unknown as { evaluate?: (expression: string) => Promise<unknown> };
  page.evaluate = async () => ['typed-by-person'];
  view.watch('ag_1');
  await view.current('ag_1');
  contexts[0].cdps[0].frame(1);
  await view.input('ag_1', 't1', { kind: 'key', type: 'down', key: 'Enter', code: 'Enter' });
  await view.takeover('ag_1', { on: false });
  await tick(); await tick();
  assert.deepEqual(saved.map((entry) => entry.value), ['typed-by-person']);
  assert.equal(woken.length, 1);
  assert.deepEqual([woken[0]!.agentId, woken[0]!.conversationId, woken[0]!.reason], ['ag_1', 'ch_1', 'message']);
  assert.match(String(woken[0]!.note), /handed my browser back.*now in the vault/);
  await view.takeover('ag_1', { on: true });
  await view.takeover('ag_1', { on: false, wake: false });
  await tick(); await tick();
  assert.equal(woken.length, 1, 'a quiet hand back wakes nobody');
  await browser.close();
});
