// A key from the environment is pay-per-use in the media paths too (PR5): image and speech
// generation on an 'env' account get a spend estimate for the permission/budget gate, and automatic
// media routing ranks it behind free connections (skipped while routing.allowPaidFallback is off):
// media/generate.ts (mediaTarget) and models/functions.ts (paid) decide 'paid' with
// models/pricing.ts chargeOf.
// Owns: these assertions only. Never: a real provider, key or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateUsd, mediaTarget, type GenerateServices } from '../../../src/runtime/media/generate.ts';
import { functionStatus } from '../../../src/runtime/models/functions.ts';
import { chargeOf } from '../../../src/runtime/models/pricing.ts';
import type { Account, ModelFunction, ModelInfo } from '../../../src/shared/model/providers.ts';
import { row } from './harness.ts';

const env = row('acc_env', { auth: 'env', envVar: 'OPENAI_API_KEY' });
const local = row('acc_local', { provider: 'vllm', auth: 'local', baseUrl: 'http://127.0.0.1:9100/v1' });

function model(account: Account, name: string, fn: ModelFunction): ModelInfo {
  return {
    id: `${account.provider}:${name}`, provider: account.provider, model: name, name, engine: 'compatible', efforts: [], caps: {},
    tier: 'local', strengths: {}, available: true, accounts: [account.id], functions: [fn],
  } as unknown as ModelInfo;
}

function services(accounts: Account[], models: ModelInfo[], allowPaidFallback: boolean): GenerateServices {
  return {
    catalog: { list: () => models, get: (id: string) => models.find((entry) => entry.id === id) },
    accounts: { get: (id: string) => accounts.find((entry) => entry.id === id), candidates: () => accounts },
    settings: { get: () => ({ routing: { functions: {}, allowPaidFallback } }) },
  } as unknown as GenerateServices;
}

test('image and speech on an environment key are paid calls with a spend estimate for the gate', () => {
  assert.equal(chargeOf(env), 'paid');
  const s = services([env], [model(env, 'gpt-image-1', 'image'), model(env, 'tts-1', 'tts')], true);
  const image = mediaTarget(s, 'image');
  const speech = mediaTarget(s, 'tts');
  assert.deepEqual([image.account.id, image.paid, speech.account.id, speech.paid], ['acc_env', true, 'acc_env', true]);
  assert.equal(estimateUsd(image, { kind: 'image', quality: 'high' }), 0.25);
  assert.equal(estimateUsd(speech, { kind: 'speech', chars: 4000 }), 0.12);
});

test('automatic media routing puts a free connection before an environment key and skips the key without paid fallback', () => {
  const accounts = [env, local];
  const models = [model(env, 'tts-1', 'tts'), model(local, 'kokoro', 'tts')];
  assert.equal(functionStatus(services(accounts, models, false), 'tts').choice?.accountId, 'acc_local');
  assert.equal(functionStatus(services(accounts, models, true), 'tts').choice?.accountId, 'acc_local', 'free first even with paid fallback allowed');
  assert.equal(functionStatus(services([env], [model(env, 'tts-1', 'tts')], false), 'tts').choice?.accountId, 'acc_env', 'the only connection still serves');
});
