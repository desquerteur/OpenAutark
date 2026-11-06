// B-058 F0: the media adapter register (runtime/media/providers/index.ts) and the new providers' wiring –
// Groq on the compatible engine, ElevenLabs and fal.ai media only (no chat engine, never an agent turn).
// T6: the built adapters refuse unknown models, and kinds a model does not make, unsent and say so (each adapter's
// own tests against a fake provider server: providers-<name>.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adapterFor, MEDIA_ADAPTERS } from '../../../src/runtime/media/providers/index.ts';
import { engineFor } from '../../../src/runtime/accounts/candidates.ts';
import { DEFAULT_BASE, endpointFor } from '../../../src/runtime/engines/http/common.ts';
import { envKeyProvider, MEDIA_ONLY_PROVIDERS, MODEL_FUNCTIONS, type ProviderId } from '../../../src/shared/model/providers.ts';
import type { GenerationKind } from '../../../src/runtime/media/providers/types.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

test('every HTTP provider has an adapter; plan CLIs and Anthropic accounts have none', () => {
  assert.equal(adapterFor('openai')?.provider, 'openai');
  assert.equal(adapterFor('groq')?.provider, 'openai', 'Groq is OpenAI-compatible');
  assert.equal(adapterFor('compatible')?.provider, 'openai');
  assert.equal(adapterFor('google')?.provider, 'google');
  assert.equal(adapterFor('elevenlabs')?.provider, 'elevenlabs');
  assert.equal(adapterFor('fal')?.provider, 'fal');
  for (const provider of ['codex', 'claude', 'anthropic', 'gemini-cli'] as const) assert.equal(adapterFor(provider), undefined, provider);
  assert.equal(MEDIA_ADAPTERS.length, 4);
});

test('B-058 T6: the Gemini, ElevenLabs and fal.ai adapters refuse a model they do not know before sending anything', async () => {
  const sent: string[] = [];
  const spy = async (url: string) => { sent.push(url); return new Response('{}'); };
  for (const adapter of MEDIA_ADAPTERS.filter((entry) => entry.provider !== 'openai')) {
    assert.deepEqual(adapter.kinds('any'), [], adapter.provider);
    await assert.rejects(adapter.generate('image', { prompt: 'x' }, { account: { provider: adapter.provider } as never, model: 'm' }, { fetch: spy, deadlineMs: Date.now() + 1000 }),
      (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable' && error.details?.fallback === true);
  }
  assert.deepEqual(sent, []);
});

test('B-058 T6: each adapter says which kinds a model makes; a kind it does not make is refused unsent and says so', async () => {
  const sent: string[] = [];
  const spy = async (url: string) => { sent.push(url); return new Response('{}'); };
  const cases: Array<[ProviderId, string, GenerationKind[], GenerationKind, RegExp]> = [
    ['google', 'lyria-3.5', ['music'], 'sound', /makes no sound/],
    ['google', 'gemini-3.8-flash-tts', ['speech'], 'image', /makes no image/],
    ['google', 'gemini-nano-banana-2.1', ['image'], 'video', /makes no video/],
    ['google', 'gemini-omni-1.1-flash', ['video'], 'music', /makes no music/],
    ['elevenlabs', 'eleven_v4', ['speech'], 'video', /makes no video/],
    ['elevenlabs', 'eleven_text_to_sound_v2', ['sound'], 'speech', /makes no speech/],
    ['elevenlabs', 'music_v2_5', ['music'], 'image', /makes no image/],
    ['fal', 'fal-ai/z-image/turbo', ['image'], 'speech', /makes no speech/],
    ['fal', 'minimax/h3-max-turbo/text-to-video', ['video'], 'sound', /makes no sound/],
  ];
  for (const [provider, model, kinds, other, said] of cases) {
    const adapter = adapterFor(provider)!;
    assert.deepEqual(adapter.kinds(model), kinds, model);
    await assert.rejects(adapter.generate(other, { prompt: 'x' }, { account: { provider } as never, model, key: async () => 'k' }, { fetch: spy, deadlineMs: Date.now() + 1000 }),
      (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable' && error.details?.fallback === true && said.test(error.message), `${model} ${other}`);
  }
  assert.deepEqual(sent, []);
  assert.deepEqual(adapterFor('google')!.kinds('gemini-3.8-flash'), [], 'a chat model makes nothing');
});

test('Groq runs on the compatible engine at its OpenAI endpoint; ElevenLabs and fal have no chat engine', () => {
  assert.equal(engineFor('groq'), 'compatible');
  assert.equal(endpointFor({ provider: 'groq' }), 'https://api.groq.com/openai/v1');
  for (const provider of MEDIA_ONLY_PROVIDERS) {
    assert.equal(engineFor(provider), undefined, provider);
    assert.ok(DEFAULT_BASE[provider]?.startsWith('https://'), provider);
  }
  assert.equal(envKeyProvider('GROQ_API_KEY'), 'groq');
  assert.equal(envKeyProvider('ELEVENLABS_API_KEY'), 'elevenlabs');
  assert.equal(envKeyProvider('FAL_KEY'), 'fal');
  assert.ok(MODEL_FUNCTIONS.includes('sound'));
});
