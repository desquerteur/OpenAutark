// MM10: the engine runner's listening turn over the real catalog and router. Only models that
// hear audio are routed (caps.audioIn, else a known family); OpenAI API models run through the
// compatible chat adapter; `avoid` keeps accounts out; without allowPaid no pay-per-use account
// listens, not even one that became usable while the router worked; listenOptions mirrors the
// router's paid spill-over rule; without a listening model the failure is NO_LISTENER.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { account, setup } from '../models/harness.ts';
import { createListener, hearsAudio, listenOptions, NO_LISTENER, PAID_OFF } from '../../../src/runtime/decision/engine-runner.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import type { EngineRegistry } from '../../../src/runtime/contracts.ts';
import type { EngineTurnInput } from '../../../src/runtime/engines/types.ts';
import type { EngineId, ModelInfo } from '../../../src/shared/model/providers.ts';
import { tempDir } from '../store/helpers.ts';

/** Helper turns make their folder below temp (engine-runner.ts HELPER_DIR): a real one, removed afterwards. */
const HELPER_TEMP = tempDir('wf-helper-');
after(() => HELPER_TEMP.cleanup());

const PRIORS = Priors.parse({
  version: 'test', categories: {},
  models: [
    { match: 'voxtral-mini*', tier: 'small', relCost: 0.02, caps: { audioIn: true }, strengths: {} },
    { match: 'gemini-deaf*', tier: 'small', relCost: 0.01, caps: { audioIn: false }, strengths: {} },
  ],
});

const AUDIO = { path: '/blobs/song', name: 'song.mp3', mime: 'audio/mpeg' };

async function listenerWith(options: { lists: Partial<Record<'openrouter' | 'ollama' | 'openai', string[]>>; allowPaid?: boolean }) {
  const h = setup({ priors: PRIORS });
  const engineOf: Record<string, EngineId> = { openrouter: 'compatible', ollama: 'compatible', openai: 'openai' };
  for (const [provider, models] of Object.entries(options.lists)) {
    h.accounts.upsert(account(`acc_${provider}`, provider as 'openrouter'), false);
    h.engine(engineOf[provider]).lists.set(provider, models!.map((model) => ({ model, name: model, efforts: ['none'] })));
  }
  if (options.allowPaid) h.settings.update({ routing: { allowPaidFallback: true } } as never);
  await h.catalog.refresh({ force: true });
  const runs: Array<{ engine: EngineId; input: EngineTurnInput }> = [];
  const engines = {
    get: (engine: EngineId) => ({
      run: async (input: EngineTurnInput) => { runs.push({ engine, input }); return { text: 'A cello.', stop: 'done', usage: { inputTokens: 600, outputTokens: 5, costUsd: 0.001 } }; },
    }),
  } as unknown as EngineRegistry;
  const listen = createListener({ engines, router: h.router, accounts: h.accounts, catalog: h.catalog, settings: h.settings, paths: { temp: HELPER_TEMP.dir }, clock: h.clock });
  return { h, listen, runs, engines };
}

const ask = { audio: AUDIO, system: 'Listen.', prompt: 'What plays?', allowPaid: true };

test('hearsAudio: the catalog flag first, else known listening families through chat completions', () => {
  const m = (model: string, patch: Partial<ModelInfo> = {}) => ({ engine: 'compatible' as EngineId, model, caps: {}, ...patch });
  for (const id of ['gemini-2.5-flash', 'models/gemini-3.8-flash', 'google/gemini-4-argon', 'gpt-4o-audio-preview', 'gpt-4o-mini-audio-preview', 'gpt-audio', 'mistralai/voxtral-small-24b', 'qwen2.5-omni-7b', 'qwen3-omni-30b-a3b', 'phi-4-multimodal-instruct']) {
    assert.equal(hearsAudio(m(id)), true, id);
  }
  for (const id of ['gpt-4o', 'llama-3.1-8b', 'gemini-2.5-flash-preview-tts', 'gemini-embedding-001', 'gemini-2.5-flash-image', 'gemini-live-2.5-flash', 'gemma-3-27b']) {
    assert.equal(hearsAudio(m(id)), false, id);
  }
  assert.equal(hearsAudio(m('llama-3.1-8b', { caps: { audioIn: true } })), true);
  assert.equal(hearsAudio(m('gemini-2.5-flash', { caps: { audioIn: false } })), false);
  assert.equal(hearsAudio(m('gpt-4o-audio-preview', { engine: 'openai' })), true);
  assert.equal(hearsAudio(m('gemini-2.5-flash', { engine: 'acp' })), false); // no input_audio there
  assert.equal(hearsAudio(m('gpt-4o-transcribe', { caps: { audioIn: true }, functions: ['stt'] })), false); // specialists never chat
});

test('createListener: routes only listeners, sends the recording to the compatible adapter and reports a paid turn', async () => {
  const { listen, runs } = await listenerWith({ lists: { openrouter: ['google/gemini-3.8-flash', 'meta/llama-4-scout', 'gemini-deaf-1'] } });
  const heard = await listen(ask);
  assert.deepEqual(heard, { text: 'A cello.', modelId: 'openrouter:google/gemini-3.8-flash', paid: true, costUsd: 0.001 });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].engine, 'compatible');
  assert.equal(runs[0].input.model, 'google/gemini-3.8-flash');
  assert.deepEqual(runs[0].input.tools, []);
  assert.deepEqual(runs[0].input.input, [{ type: 'text', text: 'What plays?' }, { type: 'audio', ...AUDIO }]);
  assert.equal(runs[0].input.outputSchema, undefined);
});

test('createListener: an OpenAI audio model runs through chat completions; avoided accounts are left out', async () => {
  const { listen, runs } = await listenerWith({ lists: { openai: ['gpt-4o-audio-preview', 'gpt-4o-mini'], ollama: ['qwen2.5-omni-7b'] }, allowPaid: true });
  const free = await listen(ask); // the free local listener wins on cost
  assert.equal(free.modelId, 'ollama:qwen2.5-omni-7b');
  assert.equal(free.paid, false);
  const paid = await listen({ ...ask, avoid: ['acc_ollama'] });
  assert.equal(paid.modelId, 'openai:gpt-4o-audio-preview');
  assert.equal(paid.paid, true);
  assert.equal(runs[1].engine, 'compatible');
  assert.equal(runs[1].input.account.id, 'acc_openai');
  await assert.rejects(listen({ ...ask, avoid: ['acc_ollama', 'acc_openai'] }), /limited right now|No other model/);
});

test('createListener: without allowPaid no pay-per-use account listens – one that became usable after the snapshot is refused unsent', async () => {
  const { h, listen, runs, engines } = await listenerWith({ lists: { openrouter: ['google/gemini-3.8-flash'], ollama: ['qwen2.5-omni-7b'] }, allowPaid: true });
  assert.equal((await listen({ ...ask, allowPaid: false })).paid, false);
  await assert.rejects(listen({ ...ask, allowPaid: false, avoid: ['acc_ollama'] }), /limited right now|No other model/);
  assert.equal(runs.length, 1);

  // The listener's own snapshot misses the paid account (cooling then); the router sees it a moment later.
  const accounts = { get: (id: string) => h.accounts.get(id), candidates: (engine: EngineId) => h.accounts.candidates(engine).filter((entry) => entry.id !== 'acc_openrouter') };
  const racing = createListener({ engines, router: h.router, accounts, catalog: h.catalog, settings: h.settings, paths: { temp: HELPER_TEMP.dir }, clock: h.clock });
  await assert.rejects(racing({ ...ask, allowPaid: false, avoid: ['acc_ollama'] }), (error: any) =>
    error.message === PAID_OFF && error.details.paid === false && error.details.billed === false && error.details.modelId === 'openrouter:google/gemini-3.8-flash');
  assert.equal(runs.length, 1, 'nothing was sent');
  assert.equal((await racing({ ...ask, avoid: ['acc_ollama'] })).paid, true);
  assert.equal(runs[1].input.account.id, 'acc_openrouter');
});

test('listenOptions: paid accounts only when Settings allow the spill-over or nothing free listens; no listener → NO_LISTENER', async () => {
  const mixed = await listenerWith({ lists: { openrouter: ['google/gemini-3.8-flash'], ollama: ['voxtral-mini-3b'] } });
  const options = listenOptions({ accounts: mixed.h.accounts, catalog: mixed.h.catalog, settings: mixed.h.settings });
  assert.deepEqual(options.models.map((model) => model.id).sort(), ['ollama:voxtral-mini-3b', 'openrouter:google/gemini-3.8-flash']);
  assert.deepEqual(options.paid.map((entry) => entry.id), ['acc_openrouter']);
  assert.equal(options.free, true);
  assert.equal(options.mayPay, false);
  mixed.h.settings.update({ routing: { allowPaidFallback: true } } as never);
  assert.equal(listenOptions({ accounts: mixed.h.accounts, catalog: mixed.h.catalog, settings: mixed.h.settings }).mayPay, true);

  const paidOnly = await listenerWith({ lists: { openrouter: ['google/gemini-3.8-flash'] } });
  const only = listenOptions({ accounts: paidOnly.h.accounts, catalog: paidOnly.h.catalog, settings: paidOnly.h.settings });
  assert.equal(only.free, false);
  assert.equal(only.mayPay, true);

  const deaf = await listenerWith({ lists: { openrouter: ['meta/llama-4-scout', 'gemini-deaf-1'] } });
  assert.equal(listenOptions({ accounts: deaf.h.accounts, catalog: deaf.h.catalog, settings: deaf.h.settings }).models.length, 0);
  await assert.rejects(deaf.listen(ask), (error: Error) => error.message === NO_LISTENER);
  assert.equal(deaf.runs.length, 0);
});

test('createListener: an engine failure carries whether a paid turn was billed', async () => {
  const { h } = await listenerWith({ lists: { openrouter: ['google/gemini-3.8-flash'] } });
  const failing = (usage?: { inputTokens: number; outputTokens: number }) => createListener({
    engines: { get: () => ({ run: async () => ({ text: '', stop: 'error', usage, error: { code: 'internal', message: 'The model response was cut off.' } }) }) } as unknown as EngineRegistry,
    router: h.router, accounts: h.accounts, catalog: h.catalog, settings: h.settings, paths: { temp: HELPER_TEMP.dir }, clock: h.clock,
  });
  await assert.rejects(failing({ inputTokens: 900, outputTokens: 4096 })(ask), (error: any) => error.code === 'internal' && error.details.billed === true && error.details.paid === true);
  await assert.rejects(failing()(ask), (error: any) => error.details.billed === false && error.details.modelId === 'openrouter:google/gemini-3.8-flash');
});
