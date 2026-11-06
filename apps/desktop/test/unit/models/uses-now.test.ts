// models.uses (runtime/models/uses.ts): what each use resolves to right now, through the resolvers the work goes through –
// "auto" shows what it really takes, a chosen model that cannot serve is named as gone, off is off, nothing is None;
// Decisions without a decision connection name the chat model that stands in, as one step left (B-072).
// Owns: nothing in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { modelUses } from '../../../src/runtime/models/uses.ts';
import { functionStatus } from '../../../src/runtime/models/functions.ts';
import { MODEL_USES, type ModelUse } from '../../../src/shared/model/models-uses.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { routesFor } from '../../../src/runtime/media/generate-route.ts';
import { account, standardSetup } from './harness.ts';

async function setupUses() {
  const h = await standardSetup();
  (h.services as unknown as { paths: unknown }).paths = { data: os.tmpdir() };
  h.settings.update({ routing: { work: 'auto' } });
  const read = async (use: ModelUse) => (await modelUses(h.services)).find((entry) => entry.use === use)!;
  return { h, read };
}

test('every use answers, in order', async () => {
  const { h } = await setupUses();
  assert.deepEqual((await modelUses(h.services)).map((entry) => entry.use), [...MODEL_USES]);
});

test('Work on "auto" with a plan: that plan, its best fit each turn', async () => {
  const { read } = await setupUses();
  const work = await read('work');
  assert.deepEqual([work.stored, work.kind, work.accountId, work.modelId, work.state], ['auto', 'plan', 'acc_claude', 'claude', 'ready']);
  assert.ok(work.name, 'names what it would take now');
});

test('a chosen model shows as itself; a choice that cannot serve is gone and something else stands in', async () => {
  const { h, read } = await setupUses();
  h.settings.update({ routing: { work: 'codex:gpt-6.1-sol' } });
  const chosen = await read('work');
  assert.deepEqual([chosen.kind, chosen.accountId, chosen.modelId, chosen.gone], ['model', 'acc_codex', 'codex:gpt-6.1-sol', undefined]);
  h.settings.update({ routing: { work: 'openai:gpt-gone' } });
  const gone = await read('work');
  assert.equal(gone.gone, 'openai:gpt-gone');
  assert.ok(gone.accountId, 'what stands in');
});

test('a plan chosen on Work; Decisions resolve through the helper route', async () => {
  const { h, read } = await setupUses();
  h.settings.update({ routing: { work: 'codex' } });
  const work = await read('work');
  assert.deepEqual([work.kind, work.accountId, work.modelId, work.gone], ['plan', 'acc_codex', 'codex', undefined]);
  h.settings.update({ routing: { decision: 'claude:claude-haiku-5-5' } });
  const decision = await read('decision');
  assert.deepEqual([decision.kind, decision.accountId, decision.modelId], ['model', 'acc_claude', 'claude:claude-haiku-5-5']);
});

test('Decisions without a decision model: the chat model that stands in, one step left, the AI as the action', async () => {
  const { h, read } = await setupUses();
  const auto = await read('decision');
  assert.deepEqual([auto.stored, auto.kind, auto.modelId, auto.state], ['auto', 'model', 'codex:gpt-6-luna', 'setup']);
  assert.equal(auto.note, `No decision model yet – ${auto.name}, a chat model, answers these calls`);
  assert.equal(auto.action?.kind, 'ai');
  h.settings.update({ routing: { decision: 'claude:claude-haiku-5-5' } });
  const chosen = await read('decision');
  assert.deepEqual([chosen.state, chosen.action?.kind], ['setup', 'ai'], 'a chat model chosen for decisions is still a stand-in');
  assert.match(chosen.note ?? '', /^No decision model yet – Claude Haiku 5\.5, a chat model/);
  h.accounts.upsert(account('typesafe', 'decision-api'), false);
  h.settings.update({ routing: { decision: 'typesafe:jev-1' } });
  const real = await read('decision');
  assert.deepEqual([real.accountId, real.name, real.state, real.note, real.action], ['typesafe', 'jev-1', 'ready', undefined, undefined], 'a decision connection is the decision model');
});

test('Embeddings on this PC are named by their model', async () => {
  const { h, read } = await setupUses();
  h.settings.update({ routing: { embeddings: 'local' } });
  const local = await read('embeddings');
  if (local.kind === 'this-pc') assert.deepEqual([local.modelId, local.name, local.state], ['local', 'MiniLM-L12 multilingual', 'ready']);
  else assert.equal(local.kind, 'none', 'a PC that cannot run the model (no ONNX runtime) has none');
});

test('a use turned off is off; a media use nothing serves is None', async () => {
  const { h, read } = await setupUses();
  h.settings.update({ routing: { video: 'off', embeddings: 'off' } });
  assert.deepEqual([(await read('video')).kind, (await read('video')).state], ['off', 'off']);
  assert.equal((await read('embeddings')).kind, 'off');
  const music = await read('music');
  assert.equal(music.kind, 'none');
  assert.equal(music.action?.kind, 'ai');
});

test('voice: This PC\'s speech while realtime is off', async () => {
  const { read } = await setupUses();
  const voice = await read('voice');
  assert.deepEqual([voice.kind, voice.thisPc], ['this-pc', true]);
  // B-072: the cell names the models that hear and speak, never the mode word
  const heard = [await read('stt'), await read('tts')].filter((now) => now.kind !== 'none' && now.kind !== 'off').map((now) => now.name);
  assert.equal(voice.name, heard.length ? heard.join(' + ') : undefined);
  assert.notEqual(voice.name, 'This PC\'s speech');
});

test('voice on "auto": without a realtime model a call is this PC\'s speech; a choice that cannot serve is gone', async () => {
  const { h, read } = await setupUses();
  h.settings.update({ voice: { realtime: 'auto' } });
  const plain = await read('voice');
  assert.deepEqual([plain.kind, plain.gone], ['this-pc', undefined]);
  h.settings.update({ routing: { voice: 'openai:gpt-realtime' } });
  assert.deepEqual([(await read('voice')).kind, (await read('voice')).gone], ['this-pc', 'openai:gpt-realtime']);
  h.accounts.upsert(account('acc_oa', 'openai'), false);
  const named = await read('voice');
  assert.deepEqual([named.kind, named.accountId, named.gone], ['model', 'acc_oa', undefined]);
  h.settings.update({ routing: { voice: 'acc_removed:gpt-realtime' } });
  const standIn = await read('voice');
  assert.deepEqual([standIn.accountId, standIn.gone], ['acc_oa', 'acc_removed:gpt-realtime'], 'another account stands in');
});

test('a chosen image model that cannot serve: the plan stands in, the choice is named as gone', async () => {
  const { h, read } = await setupUses();
  h.settings.update({ routing: { image: 'openai:gpt-image-gone' } });
  const image = await read('image');
  assert.deepEqual([image.kind, image.accountId, image.gone], ['plan', 'acc_codex', 'openai:gpt-image-gone']);
});

test('routesFor: a value naming the free route takes it first, whatever else is connected', () => {
  const account = { id: 'acc_plan', provider: 'codex', enabled: true, state: 'ok', auth: 'cli', plan: 'plus' };
  const services = {
    settings: { get: () => ({ routing: { image: 'codex', tts: 'local', allowPaidFallback: false } }) },
    accounts: { candidates: () => [account], get: () => account },
    catalog: { list: () => [] },
    stt: { localModels: () => ({ engine: { ready: true }, models: [] }) },
  } as unknown as RuntimeServices;
  assert.equal(routesFor(services, 'image').first?.via, 'plan');
  assert.equal(routesFor(services, 'speech').first?.via, 'local');
  assert.equal(functionStatus(services, 'tts').off, false);
});
