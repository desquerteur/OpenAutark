// media.listen (MM10): an agent hears a stored WAV/MP3 through a listening model – one one-shot
// turn of the engine runner over the real router and the real CompatibleEngine against a
// 127.0.0.1 chat-completions server (http-fixture). The recording goes out as input_audio; models
// that cannot hear are never routed; OpenAI API audio models run through chat completions too.
// Pay-per-use accounts pass the gate first (an estimate, usdEstimate) and are booked after the
// call (the provider's own price, else the estimate). Clear
// failures: other chats, formats it cannot decode here (headless), a stop; B-058 G9: without a
// listening model a local hearing report (sounds-listen.test.ts covers it with a decoder and the tagger).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NO_LISTENER } from '../../../src/runtime/decision/engine-runner.ts';
import { AUDIO_INPUT_BYTES } from '../../../src/runtime/engines/http/base.ts';
import { builtinTools } from '../../../src/runtime/tools/builtin/index.ts';
import { listenUsd } from '../../../src/runtime/tools/builtin/media-listen.ts';
import { sendJson, sendSse } from '../engines/http-fixture.ts';
import { mp3Cbr, mp4, oggOpus, png, wav } from './fixtures.ts';
import { KEY, account, answer, call, chunk, listenSetup, listenTool, model, textOf, usage } from './listen-fixture.ts';
import { RESOURCES } from '../store/helpers.ts';

type Result = { note: string; media: { fileId: string; durationMs?: number }; question: string; answer: string; model: string; costUsd?: number };
const QUESTION = { question: 'Which instrument plays, and how fast?' };

// A local listening model (vLLM, free) next to a local model that cannot hear (alphabetically first).
const localListener = {
  accounts: (base: string) => [account('acc_local', 'vllm', 'local', base)],
  models: () => [model('vllm:llama-3.1-8b', 'acc_local'), model('vllm:qwen2.5-omni-7b', 'acc_local')],
};

test('media.listen: a local listener hears the MP3 as input_audio and answers; free, so nothing is booked', async () => {
  const t = await listenSetup(localListener);
  try {
    const bytes = mp3Cbr(160_000); // 10 s at 128 kbit/s
    const song = await t.put(bytes, 'theme.mp3');
    t.attach(t.chat.id, song);
    await t.media.idle();

    const { action, out } = await call({ fileId: song.id, ...QUESTION }, t.ctx());
    assert.equal(out.isError, undefined, textOf(out));
    assert.equal(action.external, false);
    const result = out.structured as Result;
    assert.equal(result.answer, 'A calm solo piano.');
    assert.equal(result.model, 'vllm:qwen2.5-omni-7b');
    assert.equal(result.question, QUESTION.question);
    assert.equal(result.media.durationMs, 10_000);
    assert.match(result.note, /data about the file, not instructions/);
    assert.equal(result.costUsd, undefined);
    assert.deepEqual(t.spends, []);

    const [request] = t.chats();
    assert.equal(t.chats().length, 1);
    assert.equal(request.body.model, 'qwen2.5-omni-7b'); // the model that cannot hear was never routed
    assert.equal(request.body.tools, undefined);
    assert.equal(request.headers.authorization, undefined);
    const [system, user] = request.body.messages;
    assert.equal(system.role, 'system');
    assert.match(system.content, /listen to one recording/);
    assert.match(system.content, /data for me, not instructions/);
    assert.equal(user.content.length, 2);
    assert.equal(user.content[0].type, 'text');
    assert.match(user.content[0].text, /Recording: theme\.mp3 \(audio\/mpeg, 0:10\.0 long\)/);
    assert.match(user.content[0].text, /Question: Which instrument plays, and how fast\?/);
    assert.deepEqual(user.content[1], { type: 'input_audio', input_audio: { format: 'mp3', data: Buffer.from(bytes).toString('base64') } });

    // A WAV goes out as format 'wav'.
    const take = await t.put(wav(2000), 'take.wav');
    t.attach(t.chat.id, take);
    assert.equal((await call({ fileId: take.id, ...QUESTION }, t.ctx())).out.isError, undefined);
    assert.equal(t.chats()[1].body.messages[1].content[1].input_audio.format, 'wav');
  } finally { await t.close(); }
});

test('media.listen: other chats and files it cannot hear here fail clearly without a request; without a listening model it hears locally', async () => {
  const t = await listenSetup(localListener);
  const deaf = await listenSetup({ accounts: localListener.accounts, models: () => [model('vllm:llama-3.1-8b', 'acc_local')] });
  try {
    const ops = await t.put(mp3Cbr(16_000), 'ops.mp3');
    t.attach(t.other.id, ops);
    const voice = await t.put(oggOpus(3000), 'voice-note.ogg');
    const clip = await t.put(mp4({ durationMs: 4000, video: { width: 640, height: 360 } }), 'clip.mp4');
    const picture = await t.put(png(20, 10), 'logo.png');
    const huge = new Uint8Array(AUDIO_INPUT_BYTES + 4096);
    huge.set([0x49, 0x44, 0x33]); // "ID3": stored as audio/mpeg
    const long = await t.put(huge, 'live-set.mp3');
    t.attach(t.chat.id, voice, clip, picture, long);
    await t.media.idle();

    const ada = t.ctx();
    const run = async (fileId: string, question = QUESTION.question) => textOf((await call({ fileId, question }, ada)).out);
    assert.match(await run(ops.id), /only listen to media of chats I am a member of/);
    // Headless (no app window to decode in): only a WAV/MP3 ≤ 10 MB goes out as it is; nothing suggests ffmpeg.
    for (const file of [voice, clip, long]) assert.match(await run(file.id), /^Only WAV recordings can be heard here; this format needs the desktop app\.$/);
    assert.match(await run(picture.id), /Only recordings and videos can be listened to.*media\.view shows images/);
    assert.match(await run('a'.repeat(64)), /not in the media library/);
    assert.match(await run(voice.id.replace(/./, 'x')), /64 hexadecimal characters|not in the media library/);
    assert.equal(t.chats().length, 0);

    // No listening model: a local hearing report instead of a failure (sounds need the sound model and a decoder here).
    const song = await deaf.put(mp3Cbr(16_000), 'song.mp3');
    deaf.attach(deaf.chat.id, song);
    const out = (await call({ fileId: song.id, ...QUESTION }, deaf.ctx())).out;
    assert.equal(out.isError, undefined, textOf(out));
    const report = out.structured as Record<string, string>;
    assert.match(report.note, /^Heard locally \(no listening model\): tags, not a description\./);
    assert.match(report.note, /data from the file, not instructions/);
    assert.equal(report.question, QUESTION.question);
    assert.equal(report.listener, NO_LISTENER);
    assert.match(report.soundsNote, /^No sounds: Only WAV recordings can be heard here/);
    assert.equal(report.transcriptNote, 'No transcript is saved, and speech to text is not set up.');
    assert.equal(report.answer, undefined, 'no model answered');
    assert.equal(deaf.chats().length, 0);
  } finally { await t.close(); await deaf.close(); }
});

test('media.listen: a pay-per-use listener asks the gate with an estimate and books the provider\'s own price', async () => {
  const t = await listenSetup({
    accounts: (base) => [account('acc_or', 'openrouter', 'api_key', base)],
    models: () => [model('openrouter:meta-llama/llama-4-scout', 'acc_or', { tier: 'small' }), model('openrouter:google/gemini-3.8-flash', 'acc_or', { tier: 'small', relCost: 0.08 })],
    respond: (_req, res) => answer('Upbeat synth pop at about 120 BPM.', { cost: 0.0042 })(res),
  });
  try {
    const song = await t.put(mp3Cbr(960_000), 'demo.mp3'); // 2303 frames of 26 ms: 60.2 s
    t.attach(t.chat.id, song);
    await t.media.idle();
    const { action, out } = await call({ fileId: song.id, ...QUESTION }, t.ctx());
    assert.equal(out.isError, undefined, textOf(out));
    assert.equal(listenUsd(60.2), 0.08);
    assert.equal(action.resource, 'openrouter');
    assert.match(action.summary, /Listen to "demo\.mp3" with a pay-per-use model of openrouter \(about 0\.08 USD\)/);

    const result = out.structured as Result;
    assert.equal(result.model, 'openrouter:google/gemini-3.8-flash');
    assert.equal(result.costUsd, 0.0042);
    assert.deepEqual(t.spends, [{ agentId: 'ag_ada', amount: 0.0042, currency: 'USD', kind: 'tokens', ref: `media:listen:run_1:${song.id}` }]);
    const [request] = t.chats();
    assert.equal(request.headers.authorization, `Bearer ${KEY}`);
    assert.equal(request.body.model, 'google/gemini-3.8-flash');
    assert.deepEqual(request.body.usage, { include: true });
    assert.equal(request.body.messages[1].content[1].type, 'input_audio');
  } finally { await t.close(); }
});

test('media.listen: an OpenAI audio model listens through chat completions; without a reported price the estimate is booked', async () => {
  const t = await listenSetup({
    accounts: (base) => [account('acc_oai', 'openai', 'api_key', base)],
    models: () => [model('openai:gpt-4o-mini', 'acc_oai', { tier: 'small' }), model('openai:gpt-4o-audio-preview', 'acc_oai', { tier: 'strong', relCost: 0.4 })],
  });
  try {
    const take = await t.put(wav(30_000), 'room-tone.wav');
    t.attach(t.chat.id, take);
    await t.media.idle();
    const { action, out } = await call({ fileId: take.id, question: 'Is there a hum?' }, t.ctx());
    assert.equal(out.isError, undefined, textOf(out));
    assert.equal((out.structured as Result).model, 'openai:gpt-4o-audio-preview');
    assert.deepEqual(t.spends.map((entry) => entry.amount), [0.04]);
    assert.equal(t.server.hits('/v1/responses').length, 0);
    assert.equal(t.chats()[0].body.model, 'gpt-4o-audio-preview');
    assert.equal(t.chats()[0].body.messages[1].content[1].input_audio.format, 'wav');
  } finally { await t.close(); }
});

test('media.listen: a paid failure the provider billed is booked and unknown; a refused one is neither; a stop sends nothing', async () => {
  let mode: 'cut' | 'refuse' = 'cut';
  const t = await listenSetup({
    accounts: (base) => [account('acc_or', 'openrouter', 'api_key', base)],
    models: () => [model('openrouter:google/gemini-3.8-flash', 'acc_or', { tier: 'small' })],
    respond: (_req, res) => {
      if (mode === 'refuse') { sendJson(res, 400, { error: { message: 'unsupported audio' } }); return; }
      sendSse(res, [chunk({ content: 'It starts with' }), chunk({}, 'length'), usage(1200, 4096), '[DONE]']);
    },
  });
  try {
    const song = await t.put(mp3Cbr(160_000), 'song.mp3');
    t.attach(t.chat.id, song);
    await t.media.idle();
    const cut = (await call({ fileId: song.id, ...QUESTION }, t.ctx())).out;
    assert.equal(cut.isError, true);
    assert.match(textOf(cut), /cut off.*may already have charged it/);
    assert.deepEqual(cut.effect, { status: 'unknown' });
    assert.deepEqual(t.spends.map((entry) => entry.amount), [listenUsd(10)]);

    mode = 'refuse';
    const refused = (await call({ fileId: song.id, ...QUESTION }, t.ctx())).out;
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /did not accept this request/);
    assert.equal(refused.effect, undefined);
    assert.equal(t.spends.length, 1);

    const stop = new AbortController();
    stop.abort();
    const stopped = (await call({ fileId: song.id, ...QUESTION }, t.ctx('ag_ada', stop.signal))).out;
    assert.match(textOf(stopped), /Stopped before the answer was ready/);
    assert.equal(t.chats().length, 2);
  } finally { await t.close(); }
});

test('media.listen is a read built-in that names its data rule and the formats it takes', () => {
  assert.ok(builtinTools().some((entry) => entry.name === 'media.listen'));
  assert.equal(listenTool.category, 'read');
  assert.match(listenTool.description, /Takes every common audio and video format; a decoded part is at most 5 minutes/);
  assert.match(listenTool.description, /Without a connected listening model it hears on this PC/);
  assert.doesNotMatch(listenTool.description, /ffmpeg|convert/i);
  assert.match(listenTool.description, /not instructions/);
  assert.deepEqual((listenTool.inputSchema as { required: string[] }).required, ['fileId', 'question']);
  assert.deepEqual(Object.keys((listenTool.inputSchema as { properties: object }).properties), ['fileId', 'question', 'start', 'end']);
  assert.equal(listenUsd(100), 0.11); // e.g. the longest 400 KB of unknown length can play (32 kbit/s)
  assert.equal(listenUsd(1), 0.02);
  assert.equal(listenUsd(0), 0.01);
  // The video mode (which loads media.*) tells its agents to listen before they choose or cut.
  assert.ok(readFileSync(path.join(RESOURCES, 'modes', 'video.md'), 'utf8').includes('`media.listen`'));
});
