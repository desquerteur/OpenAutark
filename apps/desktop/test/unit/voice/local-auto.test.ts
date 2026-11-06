// B-058 G1 automatic download of the recommended local speech model (src/runtime/voice/local/auto.ts): once,
// from the first start on (also during the first run), only while nothing else was chosen, events marked auto, the setting at the end, never
// again after it ran or after the person removed a model, not on a low disk or a blocked engine, a failure
// retried at the next start; ensureTagger fetches the sound model once with its events.
// Owns: these assertions only. Never: the network or the real addon.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { Bus } from '../../../src/runtime/bus.ts';
import { AUDIO_TAGGER, SILERO_VAD, type LocalSpeechModel, type LocalSpeechPull } from '../../../src/shared/model/local-speech-models.ts';
import { AUTO_KEY, AUTO_NS, ensureTagger, LocalSpeechAuto, MAX_TRIES, type AutoRecord } from '../../../src/runtime/voice/local/auto.ts';
import { LocalSpeech } from '../../../src/runtime/voice/local/service.ts';
import { LocalSpeechEngine } from '../../../src/runtime/voice/local/engine.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { fakeAddon, installFake, quietLog, tempData } from './local-fixture.ts';

interface Options { onboarded?: boolean; voice?: Record<string, unknown>; stt?: string; record?: AutoRecord; disk?: number; blocked?: boolean; fail?: boolean; profile?: string; enabled?: boolean }

function setup(options: Options = {}) {
  const data = tempData();
  const bus = new Bus();
  const settings = {
    onboarding: { step: options.onboarded === false ? 'ai' : 'done', completed: options.onboarded !== false },
    profile: { language: options.profile ?? 'de' },
    voice: { localStt: '', localTts: '', vocabulary: [], ...options.voice },
    routing: { functions: options.stt ? { stt: options.stt } : {} },
  };
  const services = {
    paths: { data: data.dir }, log: quietLog, bus, clock: { now: () => 1_000 },
    settings: { get: () => settings, update: (patch: { voice?: Record<string, unknown> }) => { Object.assign(settings.voice, patch.voice ?? {}); bus.emit('settings.updated', settings as never); return settings; } },
  } as unknown as RuntimeServices;
  const fake = fakeAddon();
  const engine = new LocalSpeechEngine({ dataDir: () => data.dir, log: quietLog, addon: () => { if (options.blocked) throw new WorkforceError('unavailable', 'Windows blocked the local speech engine.'); return fake.addon; } });
  const installed: string[] = [];
  const install = async (model: LocalSpeechModel, deps: { progress?: (state: 'downloading' | 'unpacking', done: number, total: number) => void }) => {
    installed.push(model.id);
    if (options.fail) throw new WorkforceError('unavailable', 'Could not download it.');
    deps.progress?.('downloading', model.download.bytes, model.download.bytes);
    installFake(data.dir, model);
  };
  const local = new LocalSpeech({ services: () => services, engine, install, hardware: () => ({ totalRamMb: 7_916, freeRamMb: 700, cpuCores: 8 }), systemLocale: () => 'de-AT' });
  const kv = new Map<string, unknown>();
  if (options.record) kv.set(`${AUTO_NS}/${AUTO_KEY}`, options.record);
  const store = { get: <T>(ns: string, key: string) => kv.get(`${ns}/${key}`) as T | undefined, set: (ns: string, key: string, value: unknown) => { kv.set(`${ns}/${key}`, value); } };
  const events: LocalSpeechPull[] = [];
  bus.on('voice.pull', (event) => { events.push(event); });
  const auto = new LocalSpeechAuto({ services: () => services, local, kv: store, freeDisk: async () => options.disk, delayMs: 1, enabled: options.enabled ?? true });
  const record = () => kv.get(`${AUTO_NS}/${AUTO_KEY}`) as AutoRecord | undefined;
  return { auto, local, settings, installed, events, record, data, bus, services };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

test('the recommended model downloads by itself once: auto events, the setting at the end, kv done', async () => {
  const t = setup();
  try {
    t.auto.start();
    await settle();
    await t.auto.running();
    assert.deepEqual(t.installed, [SILERO_VAD.id, 'fastconformer-de-int8'], 'the German model for a German speaker, with the VAD');
    assert.equal(t.settings.voice.localStt, 'fastconformer-de-int8');
    assert.ok(t.events.length > 0 && t.events.every((event) => event.auto === true));
    assert.equal(t.events.at(-1)?.state, 'done');
    assert.equal(t.record()?.state, 'done');
    t.settings.voice.localStt = '';
    const again = new LocalSpeechAuto({ services: () => t.services, local: t.local, kv: { get: <T>() => t.record() as T, set: () => undefined }, delayMs: 1, enabled: true });
    again.start();
    await settle();
    assert.equal(again.running(), undefined, 'not again after it ran');
    again.stop();
  } finally { t.auto.stop(); t.data.done(); }
});

test('the first run does not hold it back: dictation hears with this PC model as soon as it can (meeting item 9)', async () => {
  const t = setup({ onboarded: false });
  try {
    t.auto.start();
    await settle();
    await t.auto.running();
    assert.deepEqual(t.installed, [SILERO_VAD.id, 'fastconformer-de-int8']);
    assert.equal(t.settings.voice.localStt, 'fastconformer-de-int8');
  } finally { t.auto.stop(); t.data.done(); }
});

test('nothing is downloaded when the person chose something, removed a model on purpose, the disk is low or the engine is blocked', async () => {
  const cases: Array<[string, Options]> = [
    ['a service is chosen', { stt: 'openai:gpt-transcribe' }],
    ['speech to text is off', { stt: 'off' }],
    ['a model is chosen', { voice: { localStt: 'canary-180m-flash-int8' } }],
    ['removed on purpose', { record: { state: 'declined', id: 'canary-180m-flash-int8', tries: 0, at: 1 } }],
    ['tried too often', { record: { state: 'failed', tries: MAX_TRIES, at: 1 } }],
    ['the disk is low', { disk: 500_000_000 }],
    ['the engine is blocked', { blocked: true }],
    ['an isolated test profile', { enabled: false }],
  ];
  for (const [why, options] of cases) {
    const t = setup(options);
    try {
      t.auto.start();
      await settle();
      await t.auto.running();
      assert.deepEqual(t.installed, [], why);
    } finally { t.auto.stop(); t.data.done(); }
  }
});

test('removing the local model is remembered; a failed download is tried again at the next start', async () => {
  const t = setup({ voice: { localStt: 'canary-180m-flash-int8' } });
  try {
    t.auto.start();
    t.settings.voice.localStt = '';
    t.bus.emit('settings.updated', t.settings as never);
    await settle();
    assert.equal(t.record()?.state, 'declined');
    assert.deepEqual(t.installed, []);
  } finally { t.auto.stop(); t.data.done(); }
  const failing = setup({ fail: true });
  try {
    failing.auto.start();
    await settle();
    await failing.auto.running();
    assert.deepEqual(failing.record(), { state: 'failed', id: 'fastconformer-de-int8', tries: 1, at: 1_000 });
    assert.equal(failing.events.at(-1)?.state, 'failed');
    assert.equal(failing.settings.voice.localStt, '');
    await failing.auto.check();
    assert.equal(failing.installed.length, 1, 'once per start');
  } finally { failing.auto.stop(); failing.data.done(); }
});

test('a German speaker with an English profile on a German PC gets the German model', async () => {
  const t = setup({ profile: 'en' });
  try {
    t.auto.start();
    await settle();
    await t.auto.running();
    assert.equal(t.settings.voice.localStt, 'fastconformer-de-int8', 'G3: the OS language (de-AT) wins over an English profile');
  } finally { t.auto.stop(); t.data.done(); }
});

test('ensureTagger downloads the sound model once, with auto events, and returns it', async () => {
  const data = tempData();
  const bus = new Bus();
  const events: LocalSpeechPull[] = [];
  bus.on('voice.pull', (event) => { events.push(event); });
  const body = new Uint8Array(16);
  try {
    const s = { paths: { data: data.dir }, bus } as unknown as RuntimeServices;
    installFake(data.dir, AUDIO_TAGGER);
    assert.equal(await ensureTagger(s, { fetch: async () => { throw new Error('no network expected'); } }), AUDIO_TAGGER, 'installed: nothing fetched');
    assert.equal(events.length, 0);
    const empty = tempData();
    try {
      const fresh = { paths: { data: empty.dir }, bus } as unknown as RuntimeServices;
      await assert.rejects(ensureTagger(fresh, { fetch: async () => new Response(body, { status: 200 }) }), /stopped before it finished|damaged/);
      assert.equal(events.at(-1)?.state, 'failed');
      assert.ok(events.every((event) => event.id === AUDIO_TAGGER.id && event.auto === true));
    } finally { empty.done(); }
  } finally { data.done(); }
});
