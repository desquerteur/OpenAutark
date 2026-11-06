// media.listen (MM10) spend rules beyond the basic flow (listen-tool.test.ts): the estimate counts
// how long the bytes play, so header fields the sender controls (an MP3's Xing frame count, a
// WAV's byte rate and data size) cannot talk the gate down; a paid listen stopped mid-call is an
// 'unknown' effect and still booked when the turn ends paid or the provider reports tokens; with
// several pay-per-use providers the call names them and no single target.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import { listenUsd, playableSeconds } from '../../../src/runtime/tools/builtin/media-listen.ts';
import { concat, mp3Cbr, str, u16le, u32be, u32le, wav, zeros } from './fixtures.ts';
import { account, call, listenSetup, listenTool, model, textOf } from './listen-fixture.ts';

const QUESTION = { question: 'What happens in the recording?' };
const paidListener = {
  accounts: (base: string) => [account('acc_or', 'openrouter', 'api_key', base)],
  models: () => [model('openrouter:google/gemini-3.8-flash', 'acc_or', { tier: 'small' })],
};

/** 60 s of 128 kbit/s frames whose Xing tag (first frame, after its 32 bytes of side info) claims one frame. */
function forgedMp3(): Uint8Array {
  const bytes = mp3Cbr(960_000);
  bytes.set(concat(str('Xing'), u32be(1), u32be(1)), 100 + 4 + 32);
  return bytes;
}

/** 30 s of 8 kHz mono 16-bit PCM whose byte rate claims 1000 times the real one and whose data size claims 2 bytes. */
function forgedWav(): Uint8Array {
  const bytes = wav(30_000);
  bytes.set(u32le(16_000_000), 28);
  bytes.set(u32le(2), 52);
  return bytes;
}

test('playableSeconds counts frames and samples, not what the headers claim; bytes it cannot explain give undefined', () => {
  assert.ok(Math.abs(playableSeconds(mp3Cbr(160_000), 'mp3')! - 384 * 1152 / 44_100) < 1e-9);
  assert.ok(Math.abs(playableSeconds(forgedMp3(), 'mp3')! - 2303 * 1152 / 44_100) < 1e-9);
  assert.equal(playableSeconds(wav(2000), 'wav'), 2);
  assert.equal(playableSeconds(forgedWav(), 'wav'), 30);
  const adpcm = wav(2000);
  adpcm.set(u16le(0x11), 20); // IMA ADPCM: samples per byte are the codec's
  assert.equal(playableSeconds(adpcm, 'wav'), undefined);
  assert.equal(playableSeconds(concat(mp3Cbr(16_000), zeros(400_000)), 'mp3'), undefined); // frames explain 4 % of it
  assert.equal(playableSeconds(zeros(50_000), 'mp3'), undefined);
  assert.equal(playableSeconds(forgedMp3(), 'wav'), undefined);
});

test('media.listen: a forged Xing frame count or WAV byte rate does not lower the estimate or the booking', async () => {
  const t = await listenSetup(paidListener);
  try {
    const song = await t.put(forgedMp3(), 'forged.mp3');
    const take = await t.put(forgedWav(), 'forged.wav');
    t.attach(t.chat.id, song, take);
    await t.media.idle();
    assert.equal(t.media.get(song.id)?.durationMs, 26); // the probe believes the header …
    assert.ok((t.media.get(take.id)?.durationMs ?? 0) < 100);

    const mp3 = await call({ fileId: song.id, ...QUESTION }, t.ctx());
    assert.equal(mp3.out.isError, undefined, textOf(mp3.out));
    const pcm = await call({ fileId: take.id, ...QUESTION }, t.ctx());
    // No provider price in these answers: the honest estimates are booked.
    assert.deepEqual(t.spends.map((entry) => entry.amount), [0.08, 0.04]);
  } finally { await t.close(); }
});

test('media.listen: a paid listen stopped mid-call is unknown, and booked when the turn still ends paid or reports tokens', async () => {
  const t = await listenSetup(paidListener);
  try {
    const song = await t.put(mp3Cbr(160_000), 'song.mp3'); // 10 s: estimate 0.02 USD
    t.attach(t.chat.id, song);
    await t.media.idle();
    let started = () => {};
    let finish: (result: EngineTurnResult) => void = () => {};
    // A provider that answers only after the stop (the HTTP request had already gone out).
    Object.assign(t.h.services, { engines: { get: () => ({ run: () => { started(); return new Promise<EngineTurnResult>((resolve) => { finish = resolve; }); } }) } });
    const stopDuring = async (late: EngineTurnResult) => {
      const running = new Promise<void>((resolve) => { started = resolve; });
      const stop = new AbortController();
      const pending = call({ fileId: song.id, ...QUESTION }, t.ctx('ag_ada', stop.signal));
      await running;
      stop.abort();
      const { out } = await pending;
      const bookedBefore = t.spends.length;
      finish(late);
      await new Promise((resolve) => setImmediate(resolve));
      return { out, bookedBefore };
    };

    const ended = await stopDuring({ text: 'Too late.', stop: 'done', usage: { inputTokens: 900, outputTokens: 12, costUsd: 0.0031 } });
    assert.match(textOf(ended.out), /Stopped before the answer was ready\. The provider may already have charged it/);
    assert.deepEqual(ended.out.effect, { status: 'unknown' });
    assert.equal(ended.bookedBefore, 0);
    assert.deepEqual(t.spends.map((entry) => entry.amount), [0.0031]);

    await stopDuring({ text: '', stop: 'interrupted', usage: { inputTokens: 900, outputTokens: 0 } }); // billed, no price: the estimate
    assert.deepEqual(t.spends.map((entry) => entry.amount), [0.0031, 0.02]);
    await stopDuring({ text: '', stop: 'interrupted' }); // nothing reported: nothing to book
    assert.equal(t.spends.length, 2);
  } finally { await t.close(); }
});

test('media.listen: with several pay-per-use providers the call names them all and no single target', async () => {
  const t = await listenSetup({
    accounts: (base) => [account('acc_or', 'openrouter', 'api_key', base), account('acc_oai', 'openai', 'api_key', base)],
    models: () => [model('openrouter:google/gemini-3.8-flash', 'acc_or', { tier: 'small' }), model('openai:gpt-4o-audio-preview', 'acc_oai', { tier: 'strong', relCost: 0.4 })],
  });
  try {
    const take = await t.put(wav(30_000), 'take.wav');
    t.attach(t.chat.id, take);
    await t.media.idle();
    const { action, out } = await call({ fileId: take.id, ...QUESTION }, t.ctx());
    assert.equal(action.resource, undefined);
    assert.match(action.summary, /with a pay-per-use model of openai or openrouter \(about 0\.04 USD\)/);
    assert.equal(out.isError, undefined, textOf(out));
    assert.deepEqual(t.spends.map((entry) => entry.amount), [listenUsd(30)]);
    const bo = listenTool.describe!({ fileId: take.id, ...QUESTION }, t.ctx('ag_bo')); // Bo is not in the chat: nothing to price
    assert.equal(bo.external, false);
  } finally { await t.close(); }
});
