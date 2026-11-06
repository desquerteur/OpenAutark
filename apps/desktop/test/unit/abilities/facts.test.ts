// B-058 G14 (T7): the abilities overview read from runtime services (runtime/abilities/facts.ts → status.ts) and
// the RPC handler (abilities.status, voice.removeLocal – its id check and tier); voice.removeLocal deletes a
// downloaded model and unchooses it (runtime/abilities/remove-model.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { abilityFacts } from '../../../src/runtime/abilities/facts.ts';
import { abilityList } from '../../../src/runtime/abilities/status.ts';
import { removeLocalModel } from '../../../src/runtime/abilities/remove-model.ts';
import { register } from '../../../src/runtime/rpc/handlers/abilities.ts';
import { register as registerApp } from '../../../src/runtime/rpc/handlers/app.ts';
import { HandlerTable, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { fitLocalSpeech, localSpeechModel } from '../../../src/shared/model/local-speech-models.ts';
import type { Account, ModelInfo } from '../../../src/shared/model/providers.ts';
import { modelDir, unpackDir } from '../../../src/runtime/voice/local/store.ts';

const codex = { id: 'acc_codex', provider: 'codex', label: 'Codex', auth: 'cli', plan: 'plus', state: 'ok', priority: 0, rotation: false, enabled: true, detected: true, createdAt: 1 } as Account;
const sol = { id: 'codex:gpt-6.1-sol', provider: 'codex', model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', engine: 'codex', efforts: [], caps: { vision: true }, tier: 'frontier', strengths: {}, available: true, accounts: [codex.id] } as unknown as ModelInfo;

function services(input: { data: string; functions?: Record<string, string>; voice?: Record<string, unknown>; installed?: string[]; tools?: string[]; engine?: boolean }): { s: RuntimeServices; updates: unknown[] } {
  let settings = {
    routing: { functions: input.functions ?? {}, allowPaidFallback: false },
    voice: { recognizer: 'auto', localStt: '', localTts: '', ...input.voice },
    profile: { language: 'de' },
    permissions: { mode: 'standard', grants: { browser: false, computerUse: true } },
  };
  const updates: unknown[] = [];
  const offers = fitLocalSpeech({ totalRamMb: 8_000, freeRamMb: 1_000, cpuCores: 4 }, 'de', (id) => (input.installed ?? []).includes(id));
  const s = {
    catalog: { list: () => [sol], get: (id: string) => (id === sol.id ? sol : undefined) },
    accounts: { list: () => [codex], get: (id: string) => (id === codex.id ? codex : undefined), candidates: () => [codex], apiKey: async () => undefined },
    settings: {
      get: () => settings,
      update: (patch: { voice?: Record<string, unknown> }) => { updates.push(patch); settings = { ...settings, voice: { ...settings.voice, ...patch.voice } }; return settings; },
    },
    stt: { localModels: () => ({ models: offers, engine: input.engine === false ? { ready: false, error: 'The local speech engine could not be loaded on this PC.' } : { ready: true } }) },
    host: { kind: 'electron', media: { keyframes: async () => ({}) } },
    tools: { get: (name: string) => ((input.tools ?? []).includes(name) ? { name } : undefined) },
    paths: { data: input.data },
    log: { info: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined },
    engines: {},
  } as unknown as RuntimeServices;
  return { s, updates };
}

async function dataDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-abilities-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('read from the services: a Codex plan sees images and makes them, nothing else is connected', async (t) => {
  const { s } = services({ data: await dataDir(t), tools: ['browser.open', 'computer.screenshot'] });
  const list = abilityList(abilityFacts(s));
  const a = Object.fromEntries(list.map((entry) => [entry.id, entry]));
  assert.deepEqual([a['see-images'].state, a['see-images'].source], ['ready', 'GPT-6.1 Sol · Codex']);
  assert.deepEqual([a['make-images'].state, a['make-images'].source], ['ready', 'ChatGPT plan via Codex']);
  assert.equal(a['hear-speech'].state, 'setup');
  assert.equal(a['hear-speech'].action?.target, 'fastconformer-de-int8', 'the model recommended for German');
  assert.deepEqual([a['use-web'].state, a['use-web'].note], ['ready', undefined]);
  assert.equal(a['use-pc'].note, undefined, 'computer use is granted');
  assert.equal(a.speak.state, 'ready', 'the local voice downloads itself on first use');
  assert.deepEqual([a['make-video'].state, a['make-video'].action?.target], ['off', 'fal']);
});

test('read from the services: the chosen downloaded model hears speech; image making turned off reads off', async (t) => {
  const { s } = services({ data: await dataDir(t), voice: { localStt: 'canary-180m-flash-int8' }, installed: ['canary-180m-flash-int8'], functions: { image: 'off' } });
  const a = Object.fromEntries(abilityList(abilityFacts(s)).map((entry) => [entry.id, entry]));
  assert.deepEqual([a['hear-speech'].state, a['hear-speech'].source], ['ready', 'Canary 180M Flash on this PC']);
  assert.deepEqual([a['make-images'].state, a['make-images'].action?.kind], ['off', 'ai']);
  assert.equal(a['use-web'].state, 'off', 'no browser tool registered here');
});

test('review fix: the chosen downloaded model with an engine that cannot load (addon blocked) does not read ready', async (t) => {
  const { s } = services({ data: await dataDir(t), voice: { localStt: 'canary-180m-flash-int8' }, installed: ['canary-180m-flash-int8'], engine: false });
  const a = Object.fromEntries(abilityList(abilityFacts(s)).map((entry) => [entry.id, entry]));
  assert.notEqual(a['hear-speech'].state, 'ready');
  assert.match(a['hear-speech'].note ?? '', /Canary 180M Flash cannot run on this PC/);
  assert.equal(a['hear-sounds'].state, 'off', 'the sound tagger needs the same engine');
  assert.notEqual(a.speak.source, 'Local voice on this PC', 'nor does the local voice speak');
});

test('voice.removeLocal: deletes the folder, unchooses the model, refuses while it unpacks', async (t) => {
  const data = await dataDir(t);
  const { s, updates } = services({ data, voice: { localStt: 'canary-180m-flash-int8' } });
  const canary = localSpeechModel('canary-180m-flash-int8')!;
  await mkdir(modelDir(data, canary), { recursive: true });
  await writeFile(path.join(modelDir(data, canary), 'tokens.txt'), 'x');
  assert.deepEqual(await removeLocalModel(s, canary.id), { ok: true });
  assert.equal(existsSync(modelDir(data, canary)), false);
  assert.deepEqual(updates, [{ voice: { localStt: '' } }]);
  await mkdir(unpackDir(data, canary), { recursive: true });
  await assert.rejects(removeLocalModel(s, canary.id), /still being downloaded/);
  await assert.rejects(removeLocalModel(s, 'ced-mini'), /Unknown local speech model/);
});

test('the handlers: abilities.status lists every ability, voice.removeLocal takes speech model ids only (tier settings)', async (t) => {
  const table = new HandlerTable();
  register(table);
  const { s } = services({ data: await dataDir(t) });
  const ctx = { services: s } as unknown as HandlerContext;
  const list = await table.get('abilities.status')!.handler(undefined as never, ctx) as unknown[];
  assert.equal(list.length, 11);
  assert.deepEqual(table.get('voice.removeLocal')!.scope, { capability: 'settings' });
  assert.throws(() => table.get('voice.removeLocal')!.handler({ id: 'silero-vad' } as never, ctx), /local speech model id/);
  assert.throws(() => table.get('voice.removeLocal')!.handler({ id: 'x', extra: 1 } as never, ctx));
});

test('voice.pullLocal takes the sound tagger too (Abilities "Download"), still no other id', async () => {
  const table = new HandlerTable();
  registerApp(table);
  const pulled: string[] = [];
  const ctx = { extras: { voice: { pullLocal: (id: string) => { pulled.push(id); return Promise.resolve({ ok: true }); } } } } as unknown as HandlerContext;
  const pull = table.get('voice.pullLocal')!;
  assert.deepEqual(await pull.handler({ id: 'ced-mini' } as never, ctx), { ok: true });
  assert.deepEqual(await pull.handler({ id: 'fastconformer-de-int8' } as never, ctx), { ok: true });
  assert.throws(() => pull.handler({ id: 'silero-vad' } as never, ctx), /local speech model id/);
  assert.deepEqual(pulled, ['ced-mini', 'fastconformer-de-int8']);
});
