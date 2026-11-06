// Function models (FN1), guards found in review: family priors from the shipped priors file do not
// hide media variants; family priors and old stored rows never make a media specialist chat-
// routable; the automatic speech-to-text pick follows the router's money rule (free first, API
// keys only as spill-over unless routing.allowPaidFallback).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { account, agent, mode, setup } from './harness.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import { buildModel, priorFor, specialties, strengthsFor } from '../../../src/runtime/models/catalog-merge.ts';
import { Catalog } from '../../../src/runtime/models/catalog.ts';
import { functionModel } from '../../../src/runtime/models/functions.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { EngineModel } from '../../../src/runtime/engines/types.ts';
import type { ProviderId } from '../../../src/shared/model/providers.ts';

const SHIPPED = Priors.load(fileURLToPath(new URL('../../../resources/model-priors.json', import.meta.url)));
const listed = (model: string): EngineModel => ({ model, name: model, efforts: [] });
const built = (provider: ProviderId, model: string, priors = SHIPPED) =>
  buildModel({ provider, engine: provider === 'openai' ? 'openai' : 'compatible', listed: listed(model), priors });

test('shipped family priors do not turn media variants into chat models', () => {
  assert.ok(SHIPPED.data.models.length > 0, 'the shipped priors file loads');
  const cases: Array<[ProviderId, string, string]> = [
    ['openai', 'gpt-6-luna-tts', 'tts'], ['openai', 'gpt-6-luna-transcribe', 'stt'], ['openai', 'gpt-6-sol-image', 'image'],
    ['google', 'gemini-3.8-flash-preview-tts', 'tts'], ['google', 'gemini-3.8-flash-image', 'image'],
    ['google', 'gemini-3.5-flash-lite-preview-tts', 'tts'], ['openrouter', 'google/gemini-3.8-flash-image-preview', 'image'],
  ];
  for (const [provider, model, fn] of cases) {
    assert.ok(priorFor(SHIPPED, model, `${provider}:${model}`)?.strengths.chat, `${model} matches a family prior with a chat strength`);
    const info = built(provider, model);
    assert.deepEqual(info.functions, [fn], model);
    assert.equal(info.name, model, `${model} keeps its own name, not the family's`);
    for (const category of ['chat', 'cheap-chat', 'coding', 'research', 'decision']) assert.equal(info.strengths[category], -1, `${model} ${category}`);
  }
  // The family members themselves stay general chat models with their curated strengths.
  assert.equal(built('openai', 'gpt-6-luna').functions, undefined);
  assert.equal(built('openai', 'gpt-6-luna').strengths.chat, 0.4);
  assert.equal(built('google', 'gemini-3.8-flash').strengths.chat, 0.4);
  // No shipped prior is itself mistaken for a media model (its literal name, wildcards removed).
  for (const entry of SHIPPED.data.models) assert.equal(built('openai', entry.match.replaceAll('*', '') || 'x').functions, undefined, entry.match);
});

test('prior overrides that name the function: false match, a model that also chats, curated function wins', () => {
  const priors = Priors.parse({ models: [
    { match: 'speechless*', strengths: { chat: 0.4, tts: -1 } },
    { match: 'whisperchat*', strengths: { chat: 0.5, stt: 0.6 } },
    { match: 'parakeet*', strengths: { stt: 0.8 } },
  ] });
  assert.deepEqual(specialties('speechless-13b', priors.forModel('speechless-13b')), []);
  assert.deepEqual(specialties('whisperchat-7b', priors.forModel('whisperchat-7b')), [], 'mixed prior: general model');
  assert.deepEqual(specialties('parakeet-speech-tdt', priors.forModel('parakeet-speech-tdt')), ['stt'], 'a curated function alone decides');
  assert.equal(built('compatible', 'speechless-13b', priors).strengths.chat, 0.4);
});

test('a family prior never lifts a media specialist above "never" for chat', () => {
  const special = specialties('gemini-2.5-flash-image-preview');
  const strengths = strengthsFor({ strengths: { chat: 0.9, 'my-custom-mode': 0.9 } } as never, special);
  assert.equal(strengths.chat, -1);
  assert.equal(strengths['my-custom-mode'], -1);
  assert.ok(strengthsFor({ strengths: { chat: 0.4 } } as never, ['decision']).chat > -1, 'a decision model keeps a curated chat value');
});

test('router: old stored chat values do not make specialists routable', async () => {
  const h = setup();
  h.accounts.upsert(account('acc_openai', 'openai'), false);
  h.engine('openai').lists.set('openai', [listed('whisper-1'), listed('gpt-image-1'), listed('gpt-6-luna')]);
  await h.catalog.refresh({ force: true });
  assert.equal(h.catalog.get('openai:gpt-image-1')?.strengths.chat, -1);
  const decision = await h.router.route({ agent: agent('ag_1'), mode: mode('chat') });
  assert.equal(decision.modelId, 'openai:gpt-6-luna');
  assert.deepEqual(decision.alternatives, []);

  // A row that stored a chat value before FN1 is "never" on read.
  h.db.run(`UPDATE models SET strengths = '{"chat":0.3,"cheap-chat":0.2}' WHERE id = 'openai:whisper-1'`);
  const reread = new Catalog({ services: () => h.services, priors: Priors.empty() });
  assert.equal(reread.get('openai:whisper-1')?.strengths.chat, -1);
  assert.equal(reread.get('openai:whisper-1')?.strengths['cheap-chat'], -1);

  // Only specialists connected: still a clear error.
  h.engine('openai').lists.set('openai', [listed('whisper-1'), listed('gpt-image-1')]);
  await h.catalog.refresh({ force: true });
  await assert.rejects(h.router.route({ agent: agent('ag_1'), mode: mode('chat') }), (error: unknown) => error instanceof WorkforceError && /suitable for/.test(error.message));
});

test('automatic speech-to-text pick: free server before an API key, keys only as spill-over', async () => {
  const h = setup();
  h.accounts.upsert(account('acc_openai', 'openai'), false); // api_key
  h.accounts.upsert(account('acc_lan', 'compatible', { auth: 'none', baseUrl: 'http://192.168.1.20:8000/v1' }), false);
  h.engine('openai').lists.set('openai', [listed('gpt-4o-mini-transcribe')]);
  h.engine('compatible').lists.set('compatible', [listed('Systran/faster-whisper-large-v3')]);
  await h.catalog.refresh({ force: true });
  const cheaper = h.catalog.get('openai:gpt-4o-mini-transcribe')!.relCost!;
  assert.ok(cheaper < h.catalog.get('compatible:Systran/faster-whisper-large-v3')!.relCost!, 'the key model looks cheaper by list price');

  const stt = () => functionModel(h.services, 'stt');
  assert.deepEqual(stt(), { modelId: 'compatible:Systran/faster-whisper-large-v3', accountId: 'acc_lan', provider: 'compatible', model: 'Systran/faster-whisper-large-v3', source: 'auto' });
  h.settings.update({ routing: { allowPaidFallback: true } });
  assert.equal(stt()?.accountId, 'acc_lan', 'paid fallback allowed: free still comes first');
  // The person's choice keeps its API key.
  h.settings.update({ routing: { allowPaidFallback: false, stt: 'openai:gpt-4o-mini-transcribe' } });
  assert.deepEqual([stt()?.accountId, stt()?.source], ['acc_openai', 'settings']);
  // Nothing free left: the API key is the spill-over.
  h.settings.update({ routing: { stt: 'auto', image: 'auto', work: 'auto' } });
  h.accounts.upsert(account('acc_lan', 'compatible', { auth: 'none', baseUrl: 'http://192.168.1.20:8000/v1', enabled: false }), false);
  assert.equal(stt()?.accountId, 'acc_openai');
});
