// B-058 T6: the catalog's media models – ElevenLabs and fal.ai accounts list their curated models (no /models of
// their own) as function specialists the resolver finds and the router never runs a turn on; Groq's whisper
// models serve speech to text; the name rules classify the current media families; listings keep audioIn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { account, agent, mode, setup } from './harness.ts';
import { buildModel, sanitizeListing, specialties } from '../../../src/runtime/models/catalog-merge.ts';
import { Catalog } from '../../../src/runtime/models/catalog.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import { functionModel } from '../../../src/runtime/models/functions.ts';
import { STATIC_MEDIA_MODELS } from '../../../src/runtime/media/providers/models.ts';
import { adapterFor } from '../../../src/runtime/media/providers/index.ts';
import { kindOfFunction } from '../../../src/runtime/media/providers/models.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { EngineModel } from '../../../src/runtime/engines/types.ts';

const listed = (model: string, extra: Partial<EngineModel> = {}): EngineModel => ({ model, name: model, efforts: [], ...extra });

test('name rules: current media families get their function; chat and listening models stay general', () => {
  const cases: Array<[string, string[]]> = [
    ['gemini-nano-banana-2.1', ['image']], ['nano-banana-pro-preview', ['image']], ['gemini-3.1-flash-image', ['image']], ['grok-imagine-image', ['image']],
    ['fal-ai/z-image', ['image']], ['gemini-omni-1.1-flash', ['video']], ['grok-imagine-video', ['video']], ['lyria-3.5', ['music']],
    ['lyria-3-clip-preview', ['music']], ['stable-audio-2.5', ['music', 'sound']], ['eleven_v4', ['tts']], ['eleven_flash_v2_5', ['tts']],
    ['eleven_text_to_sound_v2', ['sound']], ['music_v2_5', ['music']], ['scribe_v2', ['stt']], ['gemini-3.8-flash-tts', ['tts']],
    ['whisper-large-v3-turbo', ['stt']], ['distil-whisper-large-v3-en', ['stt']], ['mmaudio-v2', ['sound']],
    ['canopylabs/orpheus-v1-english', ['tts']], ['canopylabs/orpheus-arabic-saudi', ['tts']], ['playai-tts', ['tts']],
    ['gemini-3.8-flash', []], ['qwen2.5-omni-7b', []], ['gpt-4o', []], ['llama-3.3-70b-versatile', []], ['grok-4', []],
  ];
  for (const [model, expected] of cases) assert.deepEqual(specialties(model), expected, model);
});

test('curated media models: their table decides the function (fal ids end in "v2" or "turbo"), with its relative price', () => {
  for (const [provider, models] of Object.entries(STATIC_MEDIA_MODELS)) {
    for (const entry of models ?? []) {
      const info = buildModel({ provider: provider as 'fal', engine: 'compatible', listed: listed(entry.model), priors: Priors.empty() });
      assert.deepEqual(info.functions, [entry.fn], entry.model);
      assert.equal(info.relCost, entry.relCost, entry.model);
      for (const category of ['chat', 'cheap-chat', 'coding']) assert.equal(info.strengths[category], -1, `${entry.model} ${category}`);
      const kind = kindOfFunction(entry.fn);
      assert.ok(kind && adapterFor(provider as 'fal')?.kinds(entry.model).includes(kind), `${entry.model}: its adapter makes ${kind}`);
    }
  }
});

test('ElevenLabs and fal.ai accounts: curated models in the catalog, found by the function resolver, never routed for chat', async () => {
  const h = setup();
  h.accounts.upsert(account('acc_eleven', 'elevenlabs'), false);
  h.accounts.upsert(account('acc_fal', 'fal'), false);
  await h.catalog.refresh({ force: true });
  const ids = h.catalog.list().map((model) => model.id).sort();
  assert.deepEqual(ids, [...STATIC_MEDIA_MODELS.elevenlabs!.map((m) => `elevenlabs:${m.model}`), ...STATIC_MEDIA_MODELS.fal!.map((m) => `fal:${m.model}`)].sort());
  for (const model of h.catalog.list()) {
    assert.equal(model.available, true, model.id);
    assert.equal(model.engine, 'compatible', `${model.id}: the placeholder engine`);
    assert.deepEqual(model.accounts, [model.provider === 'fal' ? 'acc_fal' : 'acc_eleven']);
  }
  assert.equal(functionModel(h.services, 'tts')?.modelId, 'elevenlabs:eleven_v4');
  assert.equal(functionModel(h.services, 'video')?.modelId, 'fal:minimax/h3-max-turbo/text-to-video');
  assert.equal(functionModel(h.services, 'image')?.accountId, 'acc_fal');
  assert.equal(functionModel(h.services, 'sound')?.modelId, 'fal:fal-ai/elevenlabs/sound-effects/v2', 'the cheaper route of the same sound model');
  assert.equal(functionModel(h.services, 'stt'), undefined);
  await assert.rejects(h.router.route({ agent: agent('ag_1'), mode: mode('chat') }), (error: unknown) => error instanceof WorkforceError);

  // A restart reads the rows back: the functions stay (the table, not the name 'v2'), no engine was ever asked.
  const reread = new Catalog({ services: () => h.services, priors: Priors.empty() });
  assert.deepEqual(reread.get('fal:fal-ai/elevenlabs/sound-effects/v2')?.functions, ['sound']);
  assert.deepEqual(reread.get('fal:fal-ai/z-image/turbo')?.functions, ['image']);
  assert.deepEqual(reread.get('fal:fal-ai/z-image/turbo')?.strengths.chat, -1);
});

test('a removed media account drops its models; a stale stored row of a model no longer curated is not kept', async () => {
  const h = setup();
  h.accounts.upsert(account('acc_fal', 'fal'), false);
  await h.catalog.refresh({ force: true });
  h.db.run(`UPDATE models SET model = 'fal-ai/old-model', id = 'fal:fal-ai/old-model' WHERE id = 'fal:fal-ai/z-image/turbo'`);
  const fresh = new Catalog({ services: () => h.services, priors: Priors.empty() });
  fresh.rebuild();
  assert.equal(fresh.get('fal:fal-ai/old-model'), undefined);
  assert.ok(fresh.get('fal:fal-ai/z-image/turbo'));
  h.accounts.remove('acc_fal');
  fresh.rebuild();
  assert.deepEqual(fresh.list(), []);
});

test('Groq on the compatible engine: whisper serves speech to text, its chat models chat', async () => {
  const h = setup();
  h.accounts.upsert(account('acc_groq', 'groq'), false);
  h.engine('compatible').lists.set('groq', [listed('whisper-large-v3-turbo'), listed('llama-3.3-70b-versatile')]);
  await h.catalog.refresh({ force: true });
  assert.deepEqual(h.catalog.get('groq:whisper-large-v3-turbo')?.functions, ['stt']);
  assert.equal(h.catalog.get('groq:llama-3.3-70b-versatile')?.functions, undefined);
  assert.deepEqual(functionModel(h.services, 'stt'), { modelId: 'groq:whisper-large-v3-turbo', accountId: 'acc_groq', provider: 'groq', model: 'whisper-large-v3-turbo', source: 'auto' });
  assert.equal((await h.router.route({ agent: agent('ag_1'), mode: mode('chat') })).modelId, 'groq:llama-3.3-70b-versatile');
});

test('review: a Groq key adds no Orpheus voice and no safety classifier – media.speak keeps the local voice, chat never lands on a guard model', async () => {
  const h = setup();
  h.accounts.upsert(account('acc_groq', 'groq'), false);
  h.engine('compatible').lists.set('groq', [
    listed('whisper-large-v3-turbo'), listed('openai/gpt-oss-120b'), listed('canopylabs/orpheus-v1-english'), listed('canopylabs/orpheus-arabic-saudi'),
    listed('meta-llama/llama-prompt-guard-2-22m'), listed('meta-llama/llama-prompt-guard-2-86m'), listed('openai/gpt-oss-safeguard-20b'),
  ]);
  await h.catalog.refresh({ force: true });
  assert.deepEqual(h.catalog.list().map((model) => model.id).sort(), ['groq:openai/gpt-oss-120b', 'groq:whisper-large-v3-turbo']);
  assert.equal(functionModel(h.services, 'tts'), undefined, 'no speech model: media.speak uses the local voice');
  assert.equal(functionModel(h.services, 'stt')?.modelId, 'groq:whisper-large-v3-turbo');
  assert.equal((await h.router.route({ agent: agent('ag_1'), mode: mode('chat') })).modelId, 'groq:openai/gpt-oss-120b');
  assert.deepEqual(sanitizeListing([listed('meta-llama/llama-guard-4-12b'), listed('orpheus_tts'), listed('llama-3.3-70b')], 10).map((model) => model.model), ['llama-3.3-70b']);
});

test('T6 review: a Gemini key makes full songs (Lyria 3.5, never the 30-second clip first) and Nano Banana 2.1 images; Lyria RealTime and Gemini Transcribe are not listed', async () => {
  const gemini = async (ids: string[]) => {
    const h = setup();
    h.accounts.upsert(account('acc_google', 'google'), false);
    h.engine('compatible').lists.set('google', ids.map((id) => listed(id)));
    await h.catalog.refresh({ force: true });
    return h;
  };
  const h = await gemini(['models/gemini-3.1-flash-lite-image', 'models/gemini-3.5-transcribe', 'models/gemini-3.5-transcribe-live', 'models/gemini-3.8-flash',
    'models/gemini-nano-banana-2.1', 'models/lyria-3-clip-preview', 'models/lyria-3-pro-preview', 'models/lyria-3.5', 'models/lyria-realtime-exp']);
  assert.deepEqual(h.catalog.list().map((model) => model.model).sort(), ['models/gemini-3.1-flash-lite-image', 'models/gemini-3.8-flash', 'models/gemini-nano-banana-2.1',
    'models/lyria-3-clip-preview', 'models/lyria-3-pro-preview', 'models/lyria-3.5']);
  assert.equal(functionModel(h.services, 'music')?.model, 'models/lyria-3.5');
  assert.equal(functionModel(h.services, 'image')?.model, 'models/gemini-nano-banana-2.1');
  assert.equal(functionModel(h.services, 'stt'), undefined, 'no unreachable stt choice: dictation keeps the local model and the listening fallback');
  assert.deepEqual(h.catalog.get('google:models/lyria-3-clip-preview')?.functions, ['music']);
  assert.equal(h.catalog.get('google:models/lyria-3.5')?.strengths.chat, -1);
  const reread = new Catalog({ services: () => h.services, priors: Priors.empty() });
  assert.equal(reread.get('google:models/lyria-3.5')?.relCost, 0.15, 'a stored row keeps the curated price');
  const noSong = await gemini(['models/lyria-3-clip-preview', 'models/lyria-3-pro-preview']);
  assert.equal(functionModel(noSong.services, 'music')?.model, 'models/lyria-3-pro-preview', 'a full-song model still before the clip');
});

test('listings keep audioIn: a Codex model that hears audio gets caps.audioIn', async () => {
  assert.deepEqual(sanitizeListing([listed('m', { audioIn: true }), listed('n')], 10).map((model) => model.audioIn), [true, undefined]);
  const h = setup();
  h.accounts.upsert(account('acc_codex', 'codex'), false);
  h.engine('codex').lists.set('codex', [listed('gpt-7-ear', { efforts: ['low'], audioIn: true }), listed('gpt-6-luna', { efforts: ['low'], audioIn: false })]);
  await h.catalog.refresh({ force: true });
  assert.equal(h.catalog.get('codex:gpt-7-ear')?.caps.audioIn, true);
  assert.equal(h.catalog.get('codex:gpt-6-luna')?.caps.audioIn, false);
});
