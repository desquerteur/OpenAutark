// B-047 D14 local speech service and its RPCs (src/runtime/voice/local/service.ts, rpc/handlers/app.ts):
// voice.pullLocal joins a running download, fetches Silero VAD along with a recognizer, reports progress
// as 'voice.pull' events, chooses the model once installed, reports a failure as an event and an error;
// voice.localModels marks installed models and says when the engine cannot load on this PC (instead of
// letting the person download 154 MB first); voice.speak returns PCM16 in the chosen voice and refuses
// clearly without one; the handlers check ids, speaker numbers and who may download.
// Owns: these assertions only. Never: the real addon or the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_TAGGER, localSpeechModel, SILERO_VAD, type LocalSpeechModel, type LocalSpeechPull } from '../../../src/shared/model/local-speech-models.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { LocalSpeech, MAX_SPEAKING } from '../../../src/runtime/voice/local/service.ts';
import { LocalSpeechEngine } from '../../../src/runtime/voice/local/engine.ts';
import { HandlerTable, allowedScope, secureScope, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { register as registerApp } from '../../../src/runtime/rpc/handlers/app.ts';
import type { RpcExtras } from '../../../src/runtime/rpc/extras.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import { pcm16Samples } from '../../../src/shared/voice/wav.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { fakeAddon, installFake, quietLog, tempData } from './local-fixture.ts';

const CANARY = localSpeechModel('canary-180m-flash-int8', 'stt')!;
const VOICE = localSpeechModel('supertonic-3-int8', 'tts')!;

function setup(options: { voice?: Record<string, unknown>; install?: (model: LocalSpeechModel) => Promise<void>; engineError?: Error } = {}) {
  const data = tempData();
  const events: LocalSpeechPull[] = [];
  const updates: unknown[] = [];
  const settings = { profile: { language: 'de-DE' }, voice: { vocabulary: [], localStt: '', localTts: '', ...options.voice } };
  const services = {
    paths: { data: data.dir }, log: quietLog,
    settings: { get: () => settings, update: (patch: { voice: Record<string, unknown> }) => { updates.push(patch); Object.assign(settings.voice, patch.voice); return settings; } },
    bus: { emit: (event: string, payload: LocalSpeechPull) => { if (event === 'voice.pull') events.push(payload); } },
  } as unknown as RuntimeServices;
  const fake = fakeAddon();
  const addon = () => { if (options.engineError) throw options.engineError; return fake.addon; };
  const installed: string[] = [];
  const install = async (model: LocalSpeechModel, deps: { progress?: (state: 'downloading' | 'unpacking', done: number, total: number) => void }) => {
    installed.push(model.id);
    deps.progress?.('downloading', model.download.bytes / 2, model.download.bytes);
    await (options.install?.(model) ?? Promise.resolve());
    deps.progress?.('downloading', model.download.bytes, model.download.bytes);
    deps.progress?.('unpacking', model.download.bytes, model.download.bytes);
    installFake(data.dir, model);
  };
  const engine = new LocalSpeechEngine({ dataDir: () => data.dir, log: quietLog, addon, freeMemoryMb: () => 4_000 });
  const local = new LocalSpeech({ services: () => services, engine, install, hardware: () => ({ totalRamMb: 8_192, freeRamMb: 2_000, cpuCores: 8 }) });
  return { local, data, events, updates, installed, settings, fake };
}

test('pull: VAD comes along, progress over both, the model is chosen; a second call joins the running download', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const t = setup({ install: (model) => (model.id === CANARY.id ? gate : Promise.resolve()) });
  try {
    const first = t.local.pull(CANARY.id);
    const second = t.local.pull(CANARY.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    assert.deepEqual(await first, { ok: true });
    assert.deepEqual(await second, { ok: true });
    assert.deepEqual(t.installed, [SILERO_VAD.id, CANARY.id], 'one download each');
    const total = SILERO_VAD.download.bytes + CANARY.download.bytes;
    assert.ok(t.events.every((event) => event.id === CANARY.id && event.total === total));
    assert.deepEqual(t.events.at(-1), { id: CANARY.id, total, state: 'done', done: total });
    assert.ok(t.events.some((event) => event.state === 'unpacking' && event.done === total));
    const dones = t.events.map((event) => event.done);
    assert.deepEqual(dones, [...dones].sort((a, b) => a - b), 'progress never goes back');
    assert.deepEqual(t.updates, [{ voice: { localStt: CANARY.id } }]);
    assert.equal(t.local.sttModel()?.id, CANARY.id);
    await t.local.pull(VOICE.id);
    assert.deepEqual(t.updates.at(-1), { voice: { localTts: VOICE.id } });
    assert.ok(!t.installed.slice(2).includes(SILERO_VAD.id), 'a voice needs no VAD');
  } finally { t.data.done(); }
});

test('pull: two recognizers at once fetch Silero VAD only once (review fix: both wrote the same part file)', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const t = setup({ install: (model) => (model.id === SILERO_VAD.id ? gate : Promise.resolve()) });
  try {
    const parakeet = localSpeechModel('parakeet-tdt-0.6b-v3-int8', 'stt')!;
    const both = Promise.all([t.local.pull(CANARY.id), t.local.pull(parakeet.id)]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    assert.deepEqual(await both, [{ ok: true }, { ok: true }]);
    assert.equal(t.installed.filter((id) => id === SILERO_VAD.id).length, 1, 'one VAD download');
    assert.deepEqual([...t.installed].sort(), [CANARY.id, parakeet.id, SILERO_VAD.id].sort());
  } finally { t.data.done(); }
});

test('pull: a failure is the last event and a clear error; the setting stays; unknown ids are refused', async () => {
  const t = setup({ install: async () => { throw new WorkforceError('unavailable', 'Not enough disk space for Supertonic 3.'); } });
  try {
    await assert.rejects(t.local.pull(VOICE.id), /Not enough disk space/);
    assert.deepEqual(t.events.at(-1), { id: VOICE.id, total: VOICE.download.bytes, state: 'failed', done: 0, error: 'Not enough disk space for Supertonic 3.' });
    assert.deepEqual(t.updates, []);
    await assert.rejects(t.local.pull('kokoro-82m'), /Unknown local speech model/);
    await assert.rejects(t.local.pull(SILERO_VAD.id), /Unknown local speech model/, 'the VAD is no choice of its own');
  } finally { t.data.done(); }
});

test('B-058: the audio tagger is downloaded but never chosen; an automatic pull says so in its events and keeps a choice made meanwhile', async () => {
  const t = setup();
  try {
    assert.deepEqual(await t.local.pull(AUDIO_TAGGER.id), { ok: true });
    assert.deepEqual(t.installed, [AUDIO_TAGGER.id], 'no VAD for the tagger');
    assert.deepEqual(t.updates, [], 'no setting names the tagger');
    assert.equal(t.events.at(-1)?.state, 'done');
    assert.ok(t.events.every((event) => event.auto === undefined));
    await t.local.pull(CANARY.id, { auto: true, choose: () => false });
    assert.deepEqual(t.updates, [], 'the person chose meanwhile: the setting stays');
    assert.ok(t.events.filter((event) => event.id === CANARY.id).every((event) => event.auto === true));
    assert.ok(t.local.installed(CANARY));
  } finally { t.data.done(); }
});

test('localModels: fitted rows with installed marks; a blocked engine is said before any download', () => {
  const t = setup();
  try {
    installFake(t.data.dir, CANARY);
    const listed = t.local.models();
    assert.deepEqual(listed.engine, { ready: true });
    assert.deepEqual(listed.models.filter((row) => row.installed).map((row) => row.id), [CANARY.id]);
    assert.deepEqual(listed.models.filter((row) => row.recommended).map((row) => row.id), ['fastconformer-de-int8', VOICE.id], 'B-058 G2: the German model for a German profile');
  } finally { t.data.done(); }
  const blocked = setup({ engineError: new WorkforceError('unavailable', 'Windows blocked the local speech engine (Smart App Control or an app control policy does not trust its files on this PC yet).') });
  try {
    assert.deepEqual(blocked.local.models().engine, { ready: false, error: 'Windows blocked the local speech engine (Smart App Control or an app control policy does not trust its files on this PC yet).' });
  } finally { blocked.data.done(); }
});

test('speak: PCM16 in the chosen voice and language; blank is empty; no voice or too many lines are clear errors', async () => {
  const t = setup({ voice: { localTts: VOICE.id } });
  try {
    await assert.rejects(t.local.speak({ text: 'Hallo' }), /No local voice is downloaded on this PC/, 'chosen but not downloaded');
    installFake(t.data.dir, VOICE);
    const spoken = await t.local.speak({ text: 'Guten  Morgen,\nGerd.', voice: '3' });
    assert.equal(spoken.sampleRate, 44_100);
    assert.equal(spoken.durationMs, Math.round((4 / 44_100) * 1000));
    const samples = pcm16Samples(new Uint8Array(Buffer.from(spoken.audio, 'base64')));
    assert.deepEqual([...samples].map((v) => Math.round(v * 2) / 2), [0, 0.5, -0.5, 1]);
    const request = t.fake.state.tts[0].requests[0];
    assert.deepEqual([request.text, request.sid, (request.config.extra as { lang: string }).lang], ['Guten Morgen, Gerd.', 3, 'de']);
    assert.deepEqual(await t.local.speak({ text: '   ' }), { audio: '', sampleRate: 0, durationMs: 0 });
    const many = Array.from({ length: MAX_SPEAKING + 1 }, () => t.local.speak({ text: 'Eins.' }).then(() => 'ok', (error: Error) => error.message));
    assert.ok((await Promise.all(many)).includes('The local voice is busy. Try again in a moment.'));
  } finally { t.data.done(); }
});

test('handlers: ids and speaker numbers are checked; only the owner downloads; chat devices list and speak', async () => {
  const calls: Array<[string, unknown]> = [];
  const extras = { voice: {
    localModels: () => { calls.push(['localModels', undefined]); return { models: [], engine: { ready: true } }; },
    pullLocal: async (id: string) => { calls.push(['pullLocal', id]); return { ok: true }; },
    speak: async (input: unknown) => { calls.push(['speak', input]); return { audio: '', sampleRate: 0, durationMs: 0 }; },
  } } as unknown as RpcExtras;
  const table = new HandlerTable();
  registerApp(table);
  const call = async (method: string, params: unknown, scope: ClientScope = { kind: 'owner' }) => {
    const entry = table.get(method)!;
    if (!allowedScope(entry.scope, scope)) throw new WorkforceError('forbidden', 'Not allowed');
    const ctx: HandlerContext = { scope, services: {} as RuntimeServices, extras, topics: new Set(), signal: new AbortController().signal, secure: secureScope(scope) };
    return entry.handler(params as never, ctx);
  };
  const phone: ClientScope = { kind: 'device', deviceId: 'dev_phone0000001', capabilities: ['todo', 'chat'], secure: true };
  await call('voice.localModels', undefined, phone);
  await call('voice.speak', { text: 'Hallo', voice: '2', language: 'de-DE' }, phone);
  await call('voice.pullLocal', { id: CANARY.id });
  assert.deepEqual(calls, [['localModels', undefined], ['speak', { text: 'Hallo', voice: '2', language: 'de-DE' }], ['pullLocal', CANARY.id]]);
  await assert.rejects(call('voice.pullLocal', { id: CANARY.id }, phone), /Not allowed/);
  await assert.rejects(call('voice.pullLocal', { id: 'silero-vad' }), /local speech model id/);
  await assert.rejects(call('voice.speak', { text: 'Hallo', voice: 'Hedda' }, phone), /speaker number/);
  await assert.rejects(call('voice.speak', { text: 'x'.repeat(2_001) }, phone), /at most 2000/);
});
