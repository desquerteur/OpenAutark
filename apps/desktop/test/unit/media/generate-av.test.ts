// B-058 G13: media.music, media.sound and media.video on the one generation flow with a fake adapter (the
// GenerateServices.mediaAdapter seam): the gate judges the adapter's price before any spend and run() calls the
// adapter only after it; the per-kind deadline reaches the adapter (music/sound 180 s, video 6 min) and an
// adapter that never ends is cut after it (effect unknown, nothing booked); what comes back is stored with its
// tags, linked and described, with a ```ui audio/video block, and the provider's own price is booked; a video
// starts from a stored image the agent may read (bytes read by the flow, never by the adapter); requests out of
// range are refused before anything is sent; text instead of audio is an answered failure (booked, unknown).
// Owns: these assertions only. Never: a real provider or the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEADLINE_MS, generateMedia, generationPhase, mediaTarget, type GenerateServices } from '../../../src/runtime/media/generate.ts';
import { MediaRepo } from '../../../src/runtime/media/repo.ts';
import type { GenerationKind } from '../../../src/runtime/media/providers/types.ts';
import { png } from './fixtures.ts';
import { account, call, fakeAdapter, model, services, textOf, tool, toolSetup } from './generate-fixture.ts';

const FAL = account('acc_fal', 'api_key', 'https://queue.fal.run', 'fal');
const KINDS: GenerationKind[] = ['music', 'sound', 'video'];
const avModels = [model('fal:music-v2', 'music', 'acc_fal', 'fal'), model('fal:sfx-v1', 'sound', 'acc_fal', 'fal'), model('fal:video-v6', 'video', 'acc_fal', 'fal')];

function avSetup(fake = fakeAdapter(KINDS)) {
  const t = toolSetup([FAL]);
  Object.assign(t.h.services, services([FAL], {}, 'flux', avModels), { mediaAdapter: () => fake.adapter });
  return { ...t, fake };
}

test('music, sound and video: the gate judges the adapter\'s price first; stored, tagged, linked, a ui block back; the price booked', async () => {
  const t = avSetup(fakeAdapter(KINDS, undefined, 0.27));
  try {
    const cases = [
      { name: 'media.music', args: { prompt: 'calm lo-fi beat with soft piano', lyrics: '[Verse] Morning light', durationS: 30 }, tag: 'music', kind: 'audio', model: 'fal:music-v2', described: /^Generated song \(fal:music-v2\): calm lo-fi/, deadline: DEADLINE_MS.music },
      { name: 'media.sound', args: { prompt: 'door creaks open, then a slam', loop: false }, tag: 'sound', kind: 'audio', model: 'fal:sfx-v1', described: /^Generated sound effect \(fal:sfx-v1\)/, deadline: DEADLINE_MS.sound },
      { name: 'media.video', args: { prompt: 'a paper boat on a rainy street, slow dolly', aspect: '9:16', durationS: 6 }, tag: 'video', kind: 'video', model: 'fal:video-v6', described: /^Generated video \(fal:video-v6\)/, deadline: DEADLINE_MS.video },
    ];
    assert.deepEqual([DEADLINE_MS.music, DEADLINE_MS.sound, DEADLINE_MS.video], [180_000, 180_000, 360_000]);
    for (const [index, entry] of cases.entries()) {
      const action = tool(entry.name).describe!(entry.args, t.ctx());
      assert.equal(t.fake.calls.length, index, `${entry.name}: nothing sent while the gate judges`);
      assert.match(action.summary, new RegExp(`with ${entry.model} \\(about 0\\.27 USD\\)$`));
      const out = await tool(entry.name).run(entry.args, t.ctx());
      assert.equal(out.isError, undefined, textOf(out));
      const sent = t.fake.calls[index];
      assert.equal(sent.model, entry.model.split(':')[1]);
      assert.equal(sent.key, 'sk-test-generate-123', 'the key is read in-process for the adapter');
      assert.ok(sent.leftMs > entry.deadline - 5_000 && sent.leftMs <= entry.deadline, `${entry.name}: deadline ${sent.leftMs}`);
      const result = out.structured as { fileId: string; ui: string; durationS: number; model: string };
      assert.match(result.ui, new RegExp(`"kind":"${entry.kind}"`));
      assert.equal(result.model, entry.model);
      assert.ok(result.durationS > 0);
      const row = new MediaRepo(t.h.db).get(result.fileId)!;
      assert.deepEqual(row.tags, ['generated', entry.tag]);
      assert.equal(row.conversationId, t.chat.id);
      assert.match(row.description ?? '', entry.described);
    }
    assert.deepEqual(t.fake.calls.map((entry) => entry.request.durationS), [30, undefined, 6]);
    assert.equal(t.fake.calls[0].request.lyrics, '[Verse] Morning light');
    assert.equal(t.fake.calls[2].request.aspect, '9:16');
    assert.equal(t.spends.length, 3);
    assert.ok(t.spends.every((spend) => spend.amount === 0.27 && spend.kind === 'tokens'));
  } finally { t.temp.cleanup(); }
});

test('the provider\'s own price is booked when it names one; text instead of audio is an answered failure (booked, unknown)', async () => {
  let answer: 'priced' | 'json' = 'priced';
  const t = avSetup(fakeAdapter(KINDS, async () => (answer === 'priced'
    ? { bytes: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32)]), mime: 'audio/mpeg', extension: 'mp3', usd: 0.04 }
    : { bytes: Buffer.from('{"error":"quota"}'), mime: 'audio/mpeg', extension: 'mp3' })));
  try {
    const priced = await call('media.music', { prompt: 'jingle' }, t.ctx());
    assert.equal(priced.out.isError, undefined, textOf(priced.out));
    assert.equal(t.spends[0].amount, 0.04, 'what the provider charged');
    answer = 'json';
    const broken = (await call('media.sound', { prompt: 'thunder' }, t.ctx())).out;
    assert.equal(broken.isError, true);
    assert.match(textOf(broken), /returned text instead of audio\. The provider may already have made and charged it/);
    assert.deepEqual(broken.effect, { status: 'unknown' });
    assert.deepEqual(t.spends.map((spend) => [spend.amount, spend.ref]), [[0.04, t.spends[0].ref], [0.3, 'media:run:run_1']], 'the estimate, once the provider answered');
  } finally { t.temp.cleanup(); }
});

test('an adapter that never ends is cut after its deadline (phase sent: unknown effect, nothing booked)', { timeout: 15_000 }, async () => {
  const fake = fakeAdapter(KINDS, () => new Promise(() => undefined)); // ignores the deadline and the stop
  const s = { ...services([FAL], {}, 'flux', avModels), mediaAdapter: () => fake.adapter } as GenerateServices;
  const target = mediaTarget(s, 'video');
  const began = Date.now();
  const error = await generateMedia(s, target, { prompt: 'waves' }, { timeoutMs: 50 }).then(() => assert.fail('should time out'), (cause: Error) => cause);
  assert.match(error.message, /Video generation timed out after 1 s\./);
  assert.equal(generationPhase(error), 'sent', 'it may have been made and charged');
  assert.ok(Date.now() - began < 5_000, 'cut a short grace after the deadline');
  const stop = new AbortController();
  const stopped = generateMedia(s, target, { prompt: 'waves' }, { signal: stop.signal });
  stop.abort();
  const cut = await stopped.then(() => assert.fail('should stop'), (cause: Error) => cause);
  assert.match(cut.message, /^Stopped\.$/);
  assert.equal(generationPhase(cut), 'sent');
});

test('a video from a stored image the agent may read: the flow reads the bytes; another chat\'s image is refused', async () => {
  const t = avSetup();
  try {
    const mine = await t.put(png(20, 10), 'start.png', 'image/png');
    t.attach(t.chat.id, mine);
    const theirs = await t.put(png(30, 10), 'secret.png', 'image/png');
    t.attach(t.other.id, theirs);
    const ok = (await call('media.video', { prompt: 'zoom out slowly', imageFileId: mine.id }, t.ctx())).out;
    assert.equal(ok.isError, undefined, textOf(ok));
    const sent = t.fake.calls[0].request;
    assert.equal(sent.imageFileId, mine.id);
    assert.equal(sent.image?.mime, 'image/png');
    assert.deepEqual(Buffer.from(sent.image!.bytes), Buffer.from(png(20, 10)));
    const refused = (await call('media.video', { prompt: 'zoom out', imageFileId: theirs.id }, t.ctx())).out;
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /only animate media of chats I am a member of/);
    assert.equal(t.fake.calls.length, 1, 'nothing sent for it');
  } finally { t.temp.cleanup(); }
});

test('out-of-range requests are refused before anything is sent; no model names the key that turns it on', async () => {
  const t = avSetup();
  try {
    const long = (await call('media.sound', { prompt: 'rain', durationS: 45 }, t.ctx())).out;
    assert.match(textOf(long), /The sound effect lasts 0\.5–30 seconds/);
    const lyrics = (await call('media.music', { prompt: 'song', lyrics: 'la '.repeat(1100) }, t.ctx())).out;
    assert.match(textOf(lyrics), /Keep the lyrics under 3000 characters/);
    assert.equal(t.fake.calls.length, 0);
    Object.assign(t.h.services, { catalog: { list: () => [], get: () => undefined } });
    assert.match(textOf((await call('media.music', { prompt: 'song' }, t.ctx())).out), /Music generation is not set up: add a Gemini API key, an ElevenLabs key or a fal\.ai key/);
    assert.match(textOf((await call('media.sound', { prompt: 'rain' }, t.ctx())).out), /Sound effect generation is not set up: add an ElevenLabs key or a fal\.ai key/);
    assert.match(textOf((await call('media.video', { prompt: 'waves' }, t.ctx())).out), /Video generation is not set up: add a Gemini API key or a fal\.ai key/);
    Object.assign(t.h.services, services([FAL], { video: 'off' }, 'flux', avModels));
    assert.match(textOf((await call('media.video', { prompt: 'waves' }, t.ctx())).out), /Video generation is turned off/);
  } finally { t.temp.cleanup(); }
});
