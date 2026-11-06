// The app's stop runs what the subconscious still waits to do for a quiet chat (compose/lifecycle.ts, step 'subconscious'), right
// after the dispatcher and before the engines and the database; a runtime without it (fakes) just skips the step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { RESOURCES, fixture } from '../context/fixture.ts';
import { stopSteps } from '../../../src/runtime/compose/lifecycle.ts';
import { SubconsciousImpl } from '../../../src/runtime/subconscious/service.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import type { Core } from '../../../src/runtime/compose/services.ts';
import type { Network } from '../../../src/runtime/compose/network.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';

const network = new Proxy({}, { get: () => undefined }) as unknown as Network;

test('stop: a run still waiting for a quiet chat runs before the engines and the database stop', async () => {
  const f = fixture();
  f.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
  const calls: string[] = [];
  const runner: StructuredRunner = async () => {
    calls.push('model');
    return { text: '', structured: { tool: 'done', args: '{}' }, by: 'fake' };
  };
  const subconscious = new SubconsciousImpl({ services: () => f.services, runner, settleMs: 60_000 });
  const chat = f.chats.create({ agentIds: [f.vid.id], createdBy: 'human' });
  const message = f.chats.send({ conversationId: chat.id, authorId: 'human', body: 'Mein Steuerberater heißt Jonas Weber.' });
  subconscious.afterTurn({ agent: f.vid, conversationId: chat.id, fromSeq: 0, toSeq: message.seq, reply: 'Notiert.' });
  assert.equal(calls.length, 0, 'the chat is not quiet yet');

  const core = {
    services: { subconscious, db: { close: () => calls.push('db.close') } },
    dispatcher: { stop: () => calls.push('dispatcher') },
    engines: { dispose: () => calls.push('engines') },
  } as unknown as Core;
  const steps = stopSteps(core, network);
  const names = steps.map((step) => step.name);
  assert.ok(names.indexOf('dispatcher') < names.indexOf('subconscious') && names.indexOf('subconscious') < names.indexOf('engines') && names.indexOf('engines') < names.indexOf('database'), names.join(', '));

  await steps[names.indexOf('subconscious')].run();
  assert.deepEqual(calls, ['model']);
});

test('stop: services without it (a fake, no subconscious) skip the step', async () => {
  const core = { services: {} } as unknown as Core;
  await stopSteps(core, network).find((candidate) => candidate.name === 'subconscious')!.run();
  const bare = { services: { subconscious: { widgetFor: async () => ({ type: 'confirm' }) } } } as unknown as Core;
  await stopSteps(bare, network).find((candidate) => candidate.name === 'subconscious')!.run();
});
