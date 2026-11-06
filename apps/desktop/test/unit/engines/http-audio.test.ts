// MM10: audio input parts. Only the compatible chat adapter sends a recording (input_audio, WAV
// or MP3 ≤ 10 MB, base64, then the part's text); another format or a larger file becomes a note
// in the request (with that text). Every
// other HTTP engine gets a note instead of the recording (splitInput), and CLI engines render it
// like a file with its path (codexInput).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_INPUT_BYTES, audioFormat, audioNote, splitInput } from '../../../src/runtime/engines/http/base.ts';
import { CompatibleEngine } from '../../../src/runtime/engines/http/compatible.ts';
import { codexInput } from '../../../src/runtime/engines/codex/turn.ts';
import type { TurnInputItem } from '../../../src/runtime/engines/types.ts';
import { account, turnInput } from './fakes.ts';
import { sendSse, serve } from './http-fixture.ts';

const done = [{ id: 'cc_1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Heard.' }, finish_reason: 'stop' }] }, '[DONE]'];
const SONG = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4, 5]);

async function engineWith(files: Record<string, Uint8Array>) {
  const server = await serve((_req, res) => sendSse(res, done));
  const engine = new CompatibleEngine({
    apiKey: async () => undefined,
    readFile: async (file) => { const data = files[file]; if (!data) throw new Error('missing'); return data; },
  });
  const acc = account({ provider: 'vllm', auth: 'local', baseUrl: `${server.url}/v1` });
  return { server, engine, acc };
}

test('compatible: a WAV or MP3 recording goes out as input_audio next to the question, followed by its text', async (t) => {
  const { server, engine, acc } = await engineWith({ '/blobs/song': SONG, '/blobs/take': new Uint8Array([0x52, 0x49]) });
  t.after(() => server.close());
  const input: TurnInputItem[] = [
    { type: 'text', text: 'What plays?' },
    { type: 'audio', path: '/blobs/song', name: 'song.mp3', mime: 'audio/mpeg', text: 'The chorus starts at 0:40.' },
    { type: 'audio', path: '/blobs/take', name: 'take.wav', mime: 'audio/x-wav; codecs=1' },
  ];
  const result = await engine.run(turnInput({ account: acc, model: 'qwen2.5-omni-7b', effort: 'none', tools: [], input }).input);
  assert.equal(result.stop, 'done');
  assert.equal(result.text, 'Heard.');
  const [request] = server.hits('/v1/chat/completions');
  assert.deepEqual(request.body.messages[1].content, [
    { type: 'text', text: 'What plays?' },
    { type: 'input_audio', input_audio: { format: 'mp3', data: Buffer.from(SONG).toString('base64') } },
    { type: 'text', text: 'The chorus starts at 0:40.' },
    { type: 'input_audio', input_audio: { format: 'wav', data: Buffer.from([0x52, 0x49]).toString('base64') } },
  ]);
});

test('compatible: another format or a recording above 10 MB is never sent – a note says why', async (t) => {
  const big = new Uint8Array(AUDIO_INPUT_BYTES + 1);
  const { server, engine, acc } = await engineWith({ '/blobs/note': new Uint8Array([0x4f, 0x67]), '/blobs/set': big });
  t.after(() => server.close());
  const input: TurnInputItem[] = [
    { type: 'text', text: 'Listen.' },
    { type: 'audio', path: '/blobs/note', name: 'note.ogg', mime: 'audio/ogg', text: 'Sent from the phone.' },
    { type: 'audio', path: '/blobs/set', name: 'set.mp3', mime: 'audio/mpeg' },
  ];
  assert.equal((await engine.run(turnInput({ account: acc, tools: [], input }).input)).stop, 'done');
  const content = server.hits('/v1/chat/completions')[0].body.messages[1].content;
  // Only notes left: plain string content, as for every text-only turn.
  assert.equal(typeof content, 'string');
  assert.match(content, /\[audio: note\.ogg \(audio\/ogg\) – not sent: only WAV and MP3 can be sent\]\nSent from the phone\./);
  assert.match(content, /\[audio: set\.mp3 \(audio\/mpeg\) – not sent: larger than 10 MB\]/);
  assert.doesNotMatch(content, /input_audio/);
});

test('other engines: HTTP adapters get a note instead of the recording, CLI engines see it like a file', () => {
  const input: TurnInputItem[] = [{ type: 'text', text: 'Hi' }, { type: 'audio', path: '/blobs/song', name: 'song.mp3', mime: 'audio/mpeg', text: 'Ask media.listen.' }];
  assert.deepEqual(splitInput(input).parts, [{ type: 'text', text: 'Hi' }, { type: 'text', text: audioNote(input[1] as { name: string; mime: string; text: string }) }]);
  assert.equal(audioNote({ name: 'song.mp3', mime: 'audio/mpeg' }), '[audio: song.mp3 (audio/mpeg) – not heard: this model takes no audio]');
  assert.match((splitInput(input).parts[1] as { text: string }).text, /takes no audio\]\nAsk media\.listen\./);
  assert.deepEqual(splitInput(input, { audio: true }).parts[1], { type: 'audio', path: '/blobs/song', name: 'song.mp3', mime: 'audio/mpeg', text: 'Ask media.listen.' });
  assert.deepEqual(codexInput(input)[1], { type: 'text', text: '[file: song.mp3 (audio/mpeg) at /blobs/song]\nAsk media.listen.', text_elements: [] });
});

test('audioFormat: the type decides, the name only for an untyped file', () => {
  assert.equal(audioFormat('audio/wav'), 'wav');
  assert.equal(audioFormat('audio/vnd.wave'), 'wav');
  assert.equal(audioFormat('audio/mpeg', 'x.ogg'), 'mp3');
  assert.equal(audioFormat('AUDIO/MP3'), 'mp3');
  assert.equal(audioFormat('audio/ogg', 'x.mp3'), undefined);
  assert.equal(audioFormat('audio/mp4', 'x.m4a'), undefined);
  assert.equal(audioFormat('application/octet-stream', 'x.mp3'), 'mp3');
  assert.equal(audioFormat('', 'X.WAV'), 'wav');
  assert.equal(audioFormat('', 'x.flac'), undefined);
});
