// The turn's stop reaches the look before it (agents/turn-prepare.ts → subconscious/service.ts beforeTurn → flow.ts): the run ends at the
// stop, its model call is cut, no step follows, and a look stopped before it began makes no model call at all.
// Owns: these assertions only. Never: real models or engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { RESOURCES } from '../context/fixture.ts';
import { ledgerSetup } from '../context/ledger-fixture.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { SubconsciousImpl } from '../../../src/runtime/subconscious/service.ts';
import { planTurn } from '../../../src/runtime/agents/turn-prepare.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import { setup } from '../agents/fixture.ts';

const SAID = 'Die Rechnung an Müller geht morgen per E-Mail raus.';

/** A look whose model answers only when its call is cut; the turn would wait a minute for it. */
function stalled(t: ReturnType<typeof ledgerSetup>) {
  const calls: AbortSignal[] = [];
  const brain: StructuredRunner = (input) => {
    calls.push(input.signal!);
    return new Promise((_resolve, reject) => input.signal?.addEventListener('abort', () => reject(new Error('cut')), { once: true }));
  };
  t.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
  Object.assign(t.services, { dispatcher: { activity: () => [] }, catalog: { list: () => [] } });
  const impl = new SubconsciousImpl({ services: () => t.services, runner: brain, beforeWaitMs: 60_000 });
  return { impl, calls };
}

test('a stop during the look ends its run at once: the model call is cut and no step follows', async () => {
  const t = ledgerSetup();
  try {
    t.say(SAID);
    const { impl, calls } = stalled(t);
    const stop = new AbortController();
    const started = Date.now();
    const looking = impl.beforeTurn({ agent: t.tom, thread: t.chat.id, conversationId: t.chat.id, said: SAID, signal: stop.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 1, 'the look asked its model');
    stop.abort();
    assert.equal(await looking, undefined, 'nothing found, nothing shown');
    assert.ok(Date.now() - started < 5000, 'not the wait of the turn');
    assert.equal(calls[0].aborted, true, 'the model call was cut');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 1, 'no step after the stop');
  } finally { t.cleanup(); }
});

test('stopped before the look began: no model call', async () => {
  const t = ledgerSetup();
  try {
    t.say(SAID);
    const { impl, calls } = stalled(t);
    const stop = new AbortController();
    stop.abort();
    assert.equal(await impl.beforeTurn({ agent: t.tom, thread: t.chat.id, conversationId: t.chat.id, said: SAID, signal: stop.signal }), undefined);
    assert.equal(calls.length, 0);
  } finally { t.cleanup(); }
});

test('the turn hands its stop to the look', async () => {
  const h = setup();
  const asked: Array<{ signal?: AbortSignal }> = [];
  h.services.subconscious.beforeTurn = (input) => { asked.push(input); return Promise.resolve(undefined); };
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Wie heißt unser Steuerberater?' });
  const stop = new AbortController();
  await planTurn(h.services, h.request({ signal: stop.signal }));
  assert.equal(asked[0]?.signal, stop.signal);
});
