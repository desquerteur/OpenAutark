// B-058 T6 (G7): the listener routes by the model's engine – a Codex (or ACP) model whose catalog entry says it
// hears audio (caps.audioIn) listens on its own engine; one without the flag never does (no name guess for CLI
// engines); compatible and OpenAI models keep the chat adapter. Fake engines (decision/engine-runner.ts).

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { account, setup } from '../models/harness.ts';
import { createListener, hearsAudio, listenEngine, NO_LISTENER } from '../../../src/runtime/decision/engine-runner.ts';
import type { EngineRegistry } from '../../../src/runtime/contracts.ts';
import type { EngineTurnInput } from '../../../src/runtime/engines/types.ts';
import type { EngineId, ModelInfo } from '../../../src/shared/model/providers.ts';
import { tempDir } from '../store/helpers.ts';

const HELPER_TEMP = tempDir('wf-listen-audio-');
after(() => HELPER_TEMP.cleanup());

const AUDIO = { path: 'C:/blobs/take', name: 'take.wav', mime: 'audio/wav' };

test('hearsAudio / listenEngine: CLI engines only with caps.audioIn, on their own engine', () => {
  const m = (engine: EngineId, model: string, caps: ModelInfo['caps'] = {}) => ({ engine, model, caps });
  assert.equal(hearsAudio(m('codex', 'gpt-7-ear', { audioIn: true })), true);
  assert.equal(hearsAudio(m('codex', 'gpt-6-luna')), false);
  assert.equal(hearsAudio(m('codex', 'gpt-4o-audio')), false, 'no name guess on a CLI engine');
  assert.equal(hearsAudio(m('acp', 'gemini-3.8-flash', { audioIn: true })), true);
  assert.equal(hearsAudio(m('acp', 'gemini-3.8-flash')), false);
  assert.equal(hearsAudio(m('claude', 'claude-opus-5-5', { audioIn: true })), false);
  assert.equal(hearsAudio({ ...m('codex', 'gpt-7-ear', { audioIn: true }), functions: ['stt'] }), false);
  assert.equal(hearsAudio(m('compatible', 'gemini-omni-1.1-flash')), false, 'a video model is no listener');
  assert.deepEqual([listenEngine({ engine: 'codex' }), listenEngine({ engine: 'acp' }), listenEngine({ engine: 'openai' }), listenEngine({ engine: 'compatible' })], ['codex', 'acp', 'compatible', 'compatible']);
});

async function codexListener(models: Array<{ model: string; audioIn?: boolean }>) {
  const h = setup();
  h.accounts.upsert(account('acc_codex', 'codex'), false);
  h.engine('codex').lists.set('codex', models.map((entry) => ({ ...entry, name: entry.model, efforts: ['low'] })));
  await h.catalog.refresh({ force: true });
  const runs: Array<{ engine: EngineId; input: EngineTurnInput }> = [];
  const engines = { get: (engine: EngineId) => ({ run: async (input: EngineTurnInput) => { runs.push({ engine, input }); return { text: 'Rain.', stop: 'done' }; } }) } as unknown as EngineRegistry;
  const listen = createListener({ engines, router: h.router, accounts: h.accounts, catalog: h.catalog, settings: h.settings, paths: { temp: HELPER_TEMP.dir }, clock: h.clock });
  return { listen, runs };
}

test('createListener: a Codex plan model that hears audio listens on the Codex engine with the recording', async () => {
  const { listen, runs } = await codexListener([{ model: 'gpt-7-ear', audioIn: true }, { model: 'gpt-6-luna', audioIn: false }]);
  const heard = await listen({ audio: AUDIO, system: 'Listen.', prompt: 'What do you hear?', allowPaid: false });
  assert.deepEqual(heard, { text: 'Rain.', modelId: 'codex:gpt-7-ear', paid: false });
  assert.equal(runs[0].engine, 'codex');
  assert.equal(runs[0].input.model, 'gpt-7-ear');
  assert.deepEqual(runs[0].input.input, [{ type: 'text', text: 'What do you hear?' }, { type: 'audio', ...AUDIO }]);
});

test('createListener: today\'s text+image Codex models never listen (NO_LISTENER, nothing sent)', async () => {
  const { listen, runs } = await codexListener([{ model: 'gpt-6.1-sol', audioIn: false }, { model: 'gpt-6-luna', audioIn: false }]);
  await assert.rejects(listen({ audio: AUDIO, system: 'Listen.', prompt: 'x', allowPaid: true }), (error: Error) => error.message === NO_LISTENER);
  assert.equal(runs.length, 0);
});
