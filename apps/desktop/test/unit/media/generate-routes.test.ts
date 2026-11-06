// B-058 G11/G12 fallbacks (media/generate-route.ts, codex-image.ts, generate-local.ts) with a fake Codex engine
// and a fake local voice: without an image model media.image runs ONE read-only Codex turn on a plan login (the
// image tool's base64 or its saved file inside generated_images only; the thread deleted; plan usage, no spend);
// a paid model that fails before anything was charged hands over to the plan, one that may have been charged
// never does; without a speech model media.speak speaks in the local voice (downloaded on demand, WAV, the
// text's language, lines ≤ 2,000 characters); and the small helpers (language guess, line split).
// Owns: these assertions only. Never: a real Codex, a real model download or the network beyond 127.0.0.1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWav } from '../../../src/shared/voice/wav.ts';
import { guessLanguage, speakLocally, speechLines } from '../../../src/runtime/media/generate-local.ts';
import { MediaRepo } from '../../../src/runtime/media/repo.ts';
import type { EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import { png } from './fixtures.ts';
import { account, call, fakeCodex, fakeVoice, listen, model, services, textOf, toolSetup } from './generate-fixture.ts';

const PLAN = account('acc_plan', 'cli', '', 'codex', { plan: 'plus' });
const LUNA = model('codex:gpt-6-luna', 'image', 'acc_plan', 'codex', 'codex');
const BIG = model('codex:gpt-6.1-sol', 'image', 'acc_plan', 'codex', 'codex');
const done = (files: EngineTurnResult['files'], text = 'Here is your image.'): EngineTurnResult => ({ text, stop: 'done', files, session: { ref: 'thr_1', generation: 1 } });
const pngB64 = Buffer.from(png(32, 32)).toString('base64');

function planSetup(answer: Parameters<typeof fakeCodex>[0], accounts = [PLAN]) {
  const codex = fakeCodex(answer);
  const t = toolSetup(accounts, { engines: codex.engines, ...services(accounts, {}, 'gpt-image-1', [{ ...LUNA, functions: [] }, { ...BIG, functions: [] }]) });
  return { ...t, codex };
}

test('media.image without an image model: one read-only Codex turn on the plan, the image stored, the thread deleted, no spend', async () => {
  const t = planSetup(async () => done([{ name: 'generated-image-1.png', mime: 'image/png', dataBase64: `data:image/png;base64,${pngB64}` }]));
  try {
    const { action, out } = await call('media.image', { prompt: 'a simple flat icon of a blue microphone', size: '1536x1024' }, t.ctx());
    assert.equal(out.isError, undefined, textOf(out));
    const turn = t.codex.turns[0];
    assert.equal(t.codex.turns.length, 1, 'ONE turn');
    assert.equal(turn.model, 'gpt-6-luna', 'the small model');
    assert.equal(turn.effort, 'low');
    assert.equal(turn.readOnly, true, 'read-only: no writes');
    assert.equal(turn.nativeTools, 'image', 'B-058 i1: an image-only Codex thread (no shell, no view_image)');
    assert.deepEqual(turn.tools.map((spec) => spec.name), ['image.unable'], 'one tool of ours (an agent thread keeps image_generation), nothing else');
    assert.match((turn.input[0] as { text: string }).text, /^I make exactly one image with my image generation tool and write no files\. Format: landscape, 1536x1024 pixels\. Prompt: a simple flat icon/);
    assert.notEqual(turn.runId, 'run_1', 'its own run id (never the agent\'s steer slot)');
    assert.deepEqual(t.codex.deleted, ['thr_1'], 'nothing stays in the Codex history');
    const result = out.structured as { fileId: string; model: string };
    assert.equal(result.model, 'codex:gpt-6-luna');
    const row = new MediaRepo(t.h.db).get(result.fileId)!;
    assert.deepEqual(row.tags, ['generated', 'image']);
    assert.match(row.description ?? '', /^Generated image \(codex:gpt-6-luna\): a simple flat icon/);
    assert.equal(t.spends.length, 0, 'plan usage, no USD');
  } finally { t.temp.cleanup(); }
});

test('the plan image from its saved file: read only inside <CODEX_HOME>/generated_images', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'wf-codex-home-'));
  const inside = path.join(home, 'generated_images', 'thr_1');
  mkdirSync(inside, { recursive: true });
  writeFileSync(path.join(inside, 'exec-1.png'), png(16, 16));
  writeFileSync(path.join(home, 'auth.json.png'), png(16, 16)); // outside generated_images: never read
  const plan = { ...PLAN, home };
  let saved = path.join(inside, 'exec-1.png');
  const t = planSetup(async () => done([{ name: 'generated-image-1.png', path: saved }]), [plan]);
  try {
    const ok = (await call('media.image', { prompt: 'a red dot' }, t.ctx())).out;
    assert.equal(ok.isError, undefined, textOf(ok));
    saved = path.join(home, 'auth.json.png');
    const refused = (await call('media.image', { prompt: 'a blue dot' }, t.ctx())).out;
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /saved the image where it is not read/);
  } finally { t.temp.cleanup(); rmSync(home, { recursive: true, force: true }); }
});

test('the plan says why it made no image; its limit and a missing plan are clear errors', async () => {
  let answer: EngineTurnResult | ((input: Parameters<Parameters<typeof fakeCodex>[0]>[0]) => Promise<EngineTurnResult>) = async (input) => {
    await input.callTool('image.unable', { reason: 'The prompt asks for a real person.' }, 'c1');
    return done(undefined, 'I cannot.');
  };
  const t = planSetup(async (input) => (typeof answer === 'function' ? answer(input) : answer));
  try {
    assert.match(textOf((await call('media.image', { prompt: 'x' }, t.ctx())).out), /^Codex made no image: The prompt asks for a real person\./);
    answer = { text: '', stop: 'limit', error: { code: 'rate_limited', message: 'limit' } };
    assert.match(textOf((await call('media.image', { prompt: 'x' }, t.ctx())).out), /ChatGPT plan's usage limit is reached/);
    const keyed = toolSetup([account('acc_api', 'cli', '', 'codex', { plan: 'api' })], { engines: t.codex.engines });
    try {
      Object.assign(keyed.h.services, { catalog: { list: () => [LUNA], get: () => LUNA } });
      assert.match(textOf((await call('media.image', { prompt: 'x' }, keyed.ctx())).out), /Image generation is not set up: sign in to Codex with a ChatGPT plan/, 'an API-key login would bill the key');
    } finally { keyed.temp.cleanup(); }
  } finally { t.temp.cleanup(); }
});

test('a paid image model that fails before anything was charged hands over to the plan; one that may have been charged never does', async () => {
  const fake = await listen((_req, body) => (String(body.prompt).includes('boom') ? { status: 500, type: 'text/plain', body: 'boom' } : { status: 401, type: 'application/json', body: '{}' }));
  const paid = account('acc_paid', 'api_key', fake.base);
  const codex = fakeCodex(async () => done([{ name: 'i.png', mime: 'image/png', dataBase64: pngB64 }]));
  const t = toolSetup([paid, PLAN], { engines: codex.engines });
  Object.assign(t.h.services, services([paid, PLAN], {}, 'gpt-image-1', [{ ...LUNA, functions: [] }]));
  try {
    const { action, out } = await call('media.image', { prompt: 'a cat' }, t.ctx());
    assert.equal(out.isError, undefined, textOf(out));
    const result = out.structured as { model: string; fallback: string };
    assert.equal(result.model, 'codex:gpt-6-luna');
    assert.match(result.fallback, /rejected the image generation account.*Made with the ChatGPT plan instead\./);
    assert.equal(t.spends.length, 0, 'a refused key charged nothing; the plan is free');
    const failed = (await call('media.image', { prompt: 'boom' }, t.ctx())).out;
    assert.equal(failed.isError, true);
    assert.match(textOf(failed), /Image generation failed \(HTTP 500\)/);
    assert.equal(codex.turns.length, 1, 'no hand-over after a server error');
  } finally { fake.server.close(); t.temp.cleanup(); }
});

test('media.speak without a speech model: the local voice, downloaded on demand, WAV in the text\'s language', async () => {
  const chosen: { localTts?: string } = {};
  const voice = fakeVoice({ installed: false, voice: chosen });
  const t = toolSetup([account('acc_local', 'local', 'http://127.0.0.1:9/v1')], { stt: voice.stt });
  Object.assign(t.h.services, {
    catalog: { list: () => [], get: () => undefined },
    settings: { get: () => ({ routing: { functions: {} }, voice: chosen, profile: { language: 'en' } }) },
  });
  const notes: string[] = [];
  try {
    const ctx = { ...t.ctx(), status: (note: string) => notes.push(note) };
    const text = `Guten Morgen, das ist die Zusammenfassung für heute. ${'Und noch ein Satz für die Länge. '.repeat(70)}`;
    const { action, out } = await call('media.speak', { text, voice: '3' }, ctx);
    assert.equal(out.isError, undefined, textOf(out));
    assert.deepEqual(voice.pulls, ['supertonic-3-int8'], 'downloaded on demand');
    assert.ok(notes.some((note) => /downloading the local voice \(Supertonic 3, 129 MB\)/.test(note)));
    assert.ok(voice.lines.length >= 2, 'long text in several lines');
    assert.ok(voice.lines.every((line) => line.text.length <= 2000 && line.language === 'de' && line.voice === '3'));
    const result = out.structured as { fileId: string; mime: string; model: string; durationS: number; language: string };
    assert.equal(result.mime, 'audio/wav');
    assert.equal(result.model, 'local:supertonic-3-int8');
    assert.equal(result.language, 'de');
    const wav = parseWav(await t.h.services.files.read(result.fileId));
    assert.equal(wav.sampleRate, 24_000);
    assert.ok(Math.abs(wav.samples.length / 24_000 - (voice.lines.length * 0.1 + (voice.lines.length - 1) * 0.25)) < 0.01, 'the lines with short pauses');
    assert.deepEqual(new MediaRepo(t.h.db).get(result.fileId)?.tags, ['generated', 'speech']);
    await call('media.speak', { text: 'Hello there, this is a test of the voice.', voice: 'nova' }, t.ctx());
    assert.equal(voice.pulls.length, 1, 'downloaded once');
    assert.deepEqual([voice.lines.at(-1)!.voice, voice.lines.at(-1)!.language], ['0', 'en'], 'a model voice name speaks with voice 0');
  } finally { t.temp.cleanup(); }
});

test('the local voice: the download has its own budget (it goes on), the speaking the call\'s deadline; Stop ends the wait', async () => {
  const settings = { get: () => ({ voice: {} }) };
  const log = { warn() {} };
  let pulled = 0;
  const slowPull = { ...fakeVoice({ installed: false }).stt, pullLocal: () => { pulled++; return new Promise<never>(() => undefined); } };
  const waiting = await speakLocally({ stt: slowPull, settings, log } as never, { prompt: '', text: 'Hallo' }, { downloadMs: 30 }).then(() => assert.fail('should wait'), (error: Error) => error);
  assert.match(waiting.message, /^The local voice is still downloading\. Try again in a few minutes\.$/);
  assert.equal(pulled, 1);
  const slowSpeak = { ...fakeVoice({ installed: true }).stt, speak: () => new Promise<never>(() => undefined) };
  const chosen = { get: () => ({ voice: { localTts: 'supertonic-3-int8' } }) };
  const slow = await speakLocally({ stt: slowSpeak, settings: chosen, log } as never, { prompt: '', text: 'Hallo' }, { timeoutMs: 30 }).then(() => assert.fail('should time out'), (error: Error) => error);
  assert.match(slow.message, /took too long/);
  const stop = new AbortController();
  const pending = speakLocally({ stt: slowSpeak, settings: chosen, log } as never, { prompt: '', text: 'Hallo' }, { signal: stop.signal });
  stop.abort();
  await assert.rejects(pending, /^WorkforceError: Stopped\.$|Stopped\./);
});

test('language guess and line split', () => {
  assert.equal(guessLanguage('Straße'), 'de');
  assert.equal(guessLanguage('Das ist nicht der Weg und wir gehen'), 'de');
  assert.equal(guessLanguage('This is the way and we go'), 'en');
  assert.equal(guessLanguage('Nous avons une maison pour les enfants'), 'fr');
  assert.equal(guessLanguage('OK'), undefined, 'too little to tell');
  const lines = speechLines(`${'A sentence. '.repeat(300)}${'x'.repeat(4500)}`, 2000);
  assert.ok(lines.every((line) => line.length <= 2000));
  assert.equal(lines.join('').replace(/\s/g, '').length, ('Asentence.'.repeat(300) + 'x'.repeat(4500)).length, 'nothing lost');
});
