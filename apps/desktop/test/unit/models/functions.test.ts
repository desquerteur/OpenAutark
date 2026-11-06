// Function models (FN1): speech/image/video/music specialists in the catalog are never routed for
// chat; functionModel() honours the Settings choice and falls back to the first specialist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { account, agent, mode, setup } from './harness.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import { buildModel, specialties } from '../../../src/runtime/models/catalog-merge.ts';
import { Catalog } from '../../../src/runtime/models/catalog.ts';
import { functionModel, functionStatus } from '../../../src/runtime/models/functions.ts';
import { functionCandidates, type ModelInfo } from '../../../src/shared/model/providers.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { EngineModel } from '../../../src/runtime/engines/types.ts';
import { clock, memoryDb, recordingBus } from '../store/helpers.ts';

const OPENAI_LIST: EngineModel[] = [
  { model: 'whisper-1', name: 'whisper-1', efforts: [] },
  { model: 'gpt-4o-transcribe', name: 'gpt-4o-transcribe', efforts: [] },
  { model: 'tts-1', name: 'tts-1', efforts: [] },
  { model: 'gpt-4o-mini-tts', name: 'gpt-4o-mini-tts', efforts: [] },
  { model: 'gpt-image-1', name: 'gpt-image-1', efforts: [] },
  { model: 'dall-e-3', name: 'dall-e-3', efforts: [] },
  { model: 'sora-2', name: 'sora-2', efforts: [] },
  { model: 'gpt-6-luna', name: 'gpt-6-luna', efforts: ['low', 'medium'] },
];

/** One OpenAI API-key account listing speech/image/video specialists and one chat model. */
async function openaiSetup() {
  const h = setup();
  h.accounts.upsert(account('acc_openai', 'openai'), false);
  h.engine('openai').lists.set('openai', OPENAI_LIST);
  await h.catalog.refresh({ force: true });
  return h;
}

test('whisper, tts and gpt-image are specialists with functions and −1 ("never") for chat', async () => {
  const h = await openaiSetup();
  const fns = (id: string) => h.catalog.get(id)?.functions;
  assert.deepEqual(fns('openai:whisper-1'), ['stt']);
  assert.deepEqual(fns('openai:gpt-4o-transcribe'), ['stt']);
  assert.deepEqual(fns('openai:tts-1'), ['tts']);
  assert.deepEqual(fns('openai:gpt-4o-mini-tts'), ['tts']);
  assert.deepEqual(fns('openai:gpt-image-1'), ['image']);
  assert.deepEqual(fns('openai:dall-e-3'), ['image']);
  assert.deepEqual(fns('openai:sora-2'), ['video']);
  assert.equal(fns('openai:gpt-6-luna'), undefined, 'a chat model serves no media function');
  for (const id of ['openai:whisper-1', 'openai:tts-1', 'openai:gpt-image-1', 'openai:sora-2']) {
    const info = h.catalog.get(id)!;
    assert.equal(info.strengths.chat, -1, id);
    assert.equal(info.strengths['cheap-chat'], -1, id);
    assert.equal(info.strengths.coding, -1, id);
  }
  // Functions are derived on read (no column): a fresh catalog over the same rows reports them too.
  const reread = new Catalog({ services: () => h.services, priors: Priors.parse({ models: [] }) });
  assert.deepEqual(reread.get('openai:whisper-1')?.functions, ['stt']);
  // Name patterns for video and music; unknown names stay general.
  const named = (model: string) => specialties(model);
  assert.deepEqual(named('veo-3.0-generate-001'), ['video']);
  assert.deepEqual(named('lyria-002'), ['music']);
  assert.deepEqual(named('black-forest-labs/FLUX.1-schnell'), ['image']);
  assert.deepEqual(named('Systran/faster-whisper-large-v3'), ['stt']);
  assert.deepEqual(named('qwen3.8:27b'), []);
  assert.deepEqual(named('gpt-6.1-sol'), []);
});

test('the router never chooses a speech or image model for a chat turn, not even when pinned', async () => {
  const h = await openaiSetup();
  const chat = { agent: agent('ag_1'), mode: mode('chat') };
  for (const costMode of ['economy', 'balanced', 'best'] as const) {
    h.settings.update({ routing: { costMode } });
    const decision = await h.router.route(chat);
    assert.equal(decision.modelId, 'openai:gpt-6-luna', costMode);
    assert.ok(decision.alternatives.every((id) => id === 'openai:gpt-6-luna' || !h.catalog.get(id)?.functions), 'no specialist as an alternative');
  }
  for (const category of ['cheap-chat', 'writing', 'coding']) {
    assert.equal((await h.router.route({ agent: agent('ag_1'), mode: mode(category) })).modelId, 'openai:gpt-6-luna', category);
  }
  h.settings.update({ routing: { costMode: 'balanced', work: 'openai:whisper-1' } });
  const pinned = await h.router.route(chat);
  assert.equal(pinned.modelId, 'openai:gpt-6-luna');
  assert.equal(pinned.by, 'fallback');
  assert.match(pinned.reason, /pinned model unsuitable/);

  // Only specialists connected: a chat turn fails clearly instead of transcribing.
  const only = setup();
  only.accounts.upsert(account('acc_openai', 'openai'), false);
  only.engine('openai').lists.set('openai', OPENAI_LIST.filter((entry) => entry.model !== 'gpt-6-luna'));
  await only.catalog.refresh({ force: true });
  await assert.rejects(only.router.route(chat), (error: unknown) => error instanceof WorkforceError && /suitable for/.test(error.message));
});

test('prior overrides: a curated function makes a specialist; a prior naming the function keeps a name match general', () => {
  const priors = Priors.parse({ models: [
    { match: 'parakeet*', strengths: { stt: 0.8 } },
    { match: 'speechcraft-chat*', strengths: { chat: 0.5, writing: 0.4, tts: -1 } },
  ] });
  const parakeet = buildModel({ provider: 'compatible', engine: 'compatible', listed: { model: 'parakeet-tdt-0.6b', name: 'x', efforts: [] }, priors });
  assert.deepEqual(parakeet.functions, ['stt']);
  assert.equal(parakeet.strengths.chat, -1);
  const general = buildModel({ provider: 'compatible', engine: 'compatible', listed: { model: 'speechcraft-chat-7b', name: 'x', efforts: [] }, priors });
  assert.equal(general.functions, undefined);
  assert.equal(general.strengths.chat, 0.5);
  // Without the prior the name alone would have made it a text-to-speech model.
  assert.deepEqual(buildModel({ provider: 'compatible', engine: 'compatible', listed: { model: 'speechcraft-chat-7b', name: 'x', efforts: [] }, priors: Priors.empty() }).functions, ['tts']);
});

test('a row stored before a model counted as a specialist is not chat-routable on read', async () => {
  const h = await openaiSetup();
  h.db.run(`UPDATE models SET strengths = '{}' WHERE id = 'openai:whisper-1'`);
  const reread = new Catalog({ services: () => h.services, priors: Priors.empty() });
  assert.equal(reread.get('openai:whisper-1')?.strengths.chat, -1);
  assert.equal(reread.get('openai:gpt-6-luna')?.strengths.chat, 0.4, 'general rows stay as stored');
});

test('functionModel: the Settings choice while available, else the first specialist; off; chat pins ignored', async () => {
  const h = await openaiSetup();
  const stt = () => functionModel(h.services, 'stt');
  // No choice: the first available specialist (catalog order among equals).
  assert.equal(stt()?.source, 'auto');
  assert.equal(stt()?.accountId, 'acc_openai');
  assert.ok(['openai:whisper-1', 'openai:gpt-4o-transcribe'].includes(stt()!.modelId));
  // Pin honoured, with the provider model id for the endpoint.
  h.settings.update({ routing: { stt: 'openai:gpt-4o-transcribe' } });
  assert.deepEqual(stt(), { modelId: 'openai:gpt-4o-transcribe', accountId: 'acc_openai', provider: 'openai', model: 'gpt-4o-transcribe', source: 'settings' });
  // A bare model id (migrated without its account) matches the listing.
  h.settings.update({ routing: { stt: 'whisper-1' } });
  assert.equal(stt()?.modelId, 'openai:whisper-1');
  assert.equal(stt()?.source, 'settings');
  // A vanished pin falls back and says so.
  h.settings.update({ routing: { stt: 'openai:whisper-9' } });
  const fallback = functionStatus(h.services, 'stt');
  assert.equal(fallback.choice?.source, 'auto');
  assert.equal(fallback.settingUnavailable, true);
  // A chat model stored by the old rows is not a speech model: ignored.
  h.settings.update({ routing: { stt: 'openai:gpt-6-luna', image: 'openai:gpt-6-luna' } });
  assert.equal(stt()?.source, 'auto');
  assert.equal(functionModel(h.services, 'image')?.modelId.startsWith('openai:'), true);
  assert.ok(h.catalog.get(functionModel(h.services, 'image')!.modelId)?.functions?.includes('image'));
  // Off turns the function off; music has no model at all.
  h.settings.update({ routing: { stt: 'off' } });
  assert.equal(stt(), undefined);
  assert.equal(functionStatus(h.services, 'stt').off, true);
  assert.equal(functionModel(h.services, 'music'), undefined);
  // The account turned off → nothing resolves.
  h.settings.update({ routing: { stt: 'auto', image: 'auto', work: 'auto' } });
  h.accounts.upsert(account('acc_openai', 'openai', { enabled: false }), false);
  assert.equal(stt(), undefined);
});

test('functionModel prefers a free local speech model over a pay-per-use key', async () => {
  const h = await openaiSetup();
  h.accounts.upsert(account('acc_local', 'llamacpp', { baseUrl: 'http://127.0.0.1:8080/v1', auth: 'local' }), false);
  h.engine('compatible').lists.set('llamacpp', [{ model: 'whisper-large-v3-turbo', name: 'whisper-large-v3-turbo', efforts: [] }]);
  await h.catalog.refresh({ force: true });
  assert.deepEqual(functionModel(h.services, 'stt'), { modelId: 'llamacpp:whisper-large-v3-turbo', accountId: 'acc_local', provider: 'llamacpp', model: 'whisper-large-v3-turbo', source: 'auto' });
  h.settings.update({ routing: { stt: 'openai:whisper-1' } });
  assert.equal(functionModel(h.services, 'stt')?.modelId, 'openai:whisper-1', 'the person\'s choice beats the cheaper model');
});

