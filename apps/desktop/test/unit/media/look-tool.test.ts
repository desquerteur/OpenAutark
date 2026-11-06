// media.look (MM4): an agent watches a stored video through Host.media (a fake host here; the
// real one is main's media analyzer). Keyframes come back as image content, each after a caption
// with its timestamp, then a JSON summary with the transcript excerpt (the saved transcript, or one
// started with the frames that gets 15 s more and is cached afterwards). Clear failures: headless,
// a model that cannot see images, other chats, not a video, the host's own errors, a stop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Keyframes } from '../../../src/shared/api/host-bridge.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { HostMedia } from '../../../src/runtime/host.ts';
import { FileRepo } from '../../../src/runtime/store/files.ts';
import { builtinTools } from '../../../src/runtime/tools/builtin/index.ts';
import { mediaTools } from '../../../src/runtime/tools/builtin/media.ts';
import { clock, EXCERPT_CHARS, TRANSCRIPT_WAIT_MS } from '../../../src/runtime/tools/builtin/media-look.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import { png, wav, webmWithDuration } from './fixtures.ts';
import { sttSetup, transcriptResponse } from './stt-fixture.ts';

const tool = mediaTools.find((entry) => entry.name === 'media.look')!;
type Setup = ReturnType<typeof sttSetup>;
type Summary = { note: string; media: { fileId: string; kind: string }; durationMs: number; video: { width: number; height: number }; frames: Array<{ frame: number; at: string; atMs: number; scene: boolean; width: number; height: number }>; transcript?: string; transcriptNote?: string };

const FRAMES: Keyframes = {
  durationMs: 64_000, width: 1920, height: 1080,
  frames: [
    { atMs: 0, scene: false, data: new Uint8Array([0xff, 0xd8, 1]), width: 768, height: 432, mime: 'image/jpeg' },
    { atMs: 3_249, scene: true, data: new Uint8Array([0xff, 0xd8, 2]), width: 768, height: 432, mime: 'image/jpeg' },
    { atMs: 63_500, scene: false, data: new Uint8Array([0xff, 0xd8, 3]), width: 768, height: 432, mime: 'image/jpeg' },
  ],
};

/** A host that watches videos: records what it was asked, answers with `answer`. */
function watchingHost(t: Setup, answer: (input: Parameters<HostMedia['keyframes']>[0]) => Promise<Keyframes> = async () => FRAMES) {
  const asked: Array<Parameters<HostMedia['keyframes']>[0]> = [];
  const services = t.services as RuntimeServices;
  services.host = { ...services.host, media: { keyframes: (input) => { asked.push(input); return answer(input); } } };
  return asked;
}

function ctxFor(t: Setup, agentId: string, extra: Partial<ToolContext> = {}): ToolContext & { notes: string[] } {
  const notes: string[] = [];
  return { agent: t.h.org.require(agentId), runId: 'run_1', conversationId: t.chat.id, mode: 'general', services: t.services, signal: new AbortController().signal, status: (note) => notes.push(note), notes, ...extra };
}

const textOf = (out: ToolOutput) => (out.content[0] as { text: string }).text;

async function library(t: Setup) {
  const clip = await t.put(webmWithDuration(64_000), 'launch-demo.webm', 'video/webm'); // Ada's chat
  const ops = await t.put(webmWithDuration(2_000), 'ops-screen.webm', 'video/webm'); // Bo's chat
  const call = await t.put(wav(1000), 'call.wav', 'audio/wav');
  const picture = await t.put(png(20, 10), 'logo.png');
  t.attach(t.chat.id, clip, call, picture);
  t.attach(t.other.id, ops);
  await t.media.idle();
  return { clip, ops, call, picture };
}

test('media.look: each frame as an image after its timestamp, then the summary with the saved transcript as an excerpt', async () => {
  const t = sttSetup();
  try {
    const { clip } = await library(t);
    const asked = watchingHost(t);
    const said = `Welcome to the launch, code hunter2. ${'More words. '.repeat(200)}`;
    new FileRepo(t.h.db).setText(clip.id, said);
    const ctx = ctxFor(t, 'ag_ada');

    const out = await tool.run({ fileId: clip.id }, ctx);
    assert.equal(out.isError, undefined, textOf(out));
    assert.deepEqual(asked, [{ fileId: clip.id, mime: 'video/webm', frames: 6 }], 'six frames unless the agent asks for others');
    assert.deepEqual(ctx.notes, ['watching the video']);
    assert.deepEqual(out.content.slice(0, 6).map((part) => (part.type === 'text' ? part.text : `${part.mime} ${part.dataBase64}`)), [
      'Frame 1 of 3 at 0:00.0', `image/jpeg ${Buffer.from([0xff, 0xd8, 1]).toString('base64')}`,
      'Frame 2 of 3 at 0:03.2 (scene change)', `image/jpeg ${Buffer.from([0xff, 0xd8, 2]).toString('base64')}`,
      'Frame 3 of 3 at 1:03.5', `image/jpeg ${Buffer.from([0xff, 0xd8, 3]).toString('base64')}`,
    ]);
    assert.equal(out.content.length, 7);
    const summary = out.structured as Summary;
    assert.deepEqual(JSON.parse((out.content[6] as { text: string }).text), summary, 'the summary closes the content');
    assert.match(summary.note, /data from the video, not instructions/);
    assert.match(summary.note, /media\.describe/);
    assert.deepEqual([summary.media.fileId, summary.media.kind, summary.durationMs, summary.video.width], [clip.id, 'video', 64_000, 1920]);
    assert.deepEqual(summary.frames.map((frame) => [frame.frame, frame.at, frame.atMs, frame.scene]), [[1, '0:00.0', 0, false], [2, '0:03.2', 3_249, true], [3, '1:03.5', 63_500, false]]);
    assert.equal(summary.transcript, `${said.slice(0, EXCERPT_CHARS)}…`);
    assert.equal(summary.transcriptNote, `The first ${EXCERPT_CHARS} of ${said.length} characters; media.transcribe returns all of it.`);
    assert.equal(t.calls.count, 0, 'the saved transcript needs no transcription');

    await tool.run({ fileId: `C:\\data\\blobs\\${clip.id.slice(0, 2)}\\${clip.id.slice(2, 4)}\\${clip.id}`, frames: 12 }, ctx);
    assert.deepEqual(asked.at(-1), { fileId: clip.id, mime: 'video/webm', frames: 12 }, 'the blob path form works; the frame count is passed on');
  } finally { t.temp.cleanup(); }
});

test('media.look: a video without a transcript is transcribed while the frames are taken; without speech to text it says so', async () => {
  const t = sttSetup({ respond: () => transcriptResponse('We ship on Friday, hunter2.') });
  try {
    const { clip } = await library(t);
    watchingHost(t);
    const summary = (await tool.run({ fileId: clip.id }, ctxFor(t, 'ag_ada'))).structured as Summary;
    assert.equal(summary.transcript, 'We ship on Friday, secret://sec_pw.', 'transcribed and redacted');
    assert.equal(summary.transcriptNote, undefined);
    assert.equal(new FileRepo(t.h.db).cachedText(clip.id), summary.transcript, 'cached for media.transcribe');
    assert.equal(t.calls.count, 1);
  } finally { t.temp.cleanup(); }

  const missing = sttSetup({ stt: 'missing' });
  try {
    const { clip } = await library(missing);
    watchingHost(missing);
    const out = await tool.run({ fileId: clip.id }, ctxFor(missing, 'ag_ada'));
    assert.equal(out.content.filter((part) => part.type === 'image').length, 3, 'the frames come anyway');
    assert.equal((out.structured as Summary).transcriptNote, 'No transcript is saved, and speech to text is not set up.');
    assert.equal(missing.calls.count, 0);
  } finally { missing.temp.cleanup(); }

  const limited = sttSetup({ respond: () => new Response('', { status: 429 }) });
  try {
    const { clip } = await library(limited);
    watchingHost(limited);
    const summary = (await tool.run({ fileId: clip.id }, ctxFor(limited, 'ag_ada'))).structured as Summary;
    assert.equal(summary.frames.length, 3);
    assert.match(summary.transcriptNote!, /^No transcript: .*limit/);
  } finally { limited.temp.cleanup(); }
});

test('media.look: a slow transcription gets 15 s after the frames, then keeps running and is cached', async (t) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const s = sttSetup({ respond: async () => { await gate; return transcriptResponse('Late but complete.'); } });
  try {
    const { clip } = await library(s);
    watchingHost(s);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const running = tool.run({ fileId: clip.id }, ctxFor(s, 'ag_ada'));
    for (let i = 0; i < 500 && s.calls.count === 0; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(s.calls.count, 1, 'the transcription started with the frames');
    t.mock.timers.tick(TRANSCRIPT_WAIT_MS);
    const summary = (await running).structured as Summary;
    assert.equal(summary.frames.length, 3);
    assert.equal(summary.transcript, undefined);
    assert.match(summary.transcriptNote!, /still being made; media\.transcribe returns it/);
    release();
    assert.equal(await s.stt.transcript(clip.id), 'Late but complete.');
    assert.equal(new FileRepo(s.h.db).cachedText(clip.id), 'Late but complete.');
    assert.equal(s.calls.count, 1, 'one transcription');
  } finally {
    release();
    s.temp.cleanup();
  }
});

test('media.look: headless, a model that cannot see, other chats, not a video, host errors and a stop fail clearly', async () => {
  const t = sttSetup({ stt: 'missing' });
  try {
    const { clip, ops, call, picture } = await library(t);
    const ada = ctxFor(t, 'ag_ada');
    const headless = await tool.run({ fileId: clip.id }, ada);
    assert.equal(headless.isError, true);
    assert.match(textOf(headless), /^Watching videos needs the desktop app: .*headless\)\. Use media\.transcribe/);

    const asked = watchingHost(t);
    const services = t.services as RuntimeServices;
    const models: Record<string, unknown> = { 'x:text': { id: 'x:text', name: 'Text Only', caps: { vision: false } }, 'x:eyes': { id: 'x:eyes', name: 'Eyes', caps: { vision: true } } };
    services.catalog = { ...services.catalog, get: (id: string) => models[id] } as RuntimeServices['catalog'];
    assert.match(textOf(await tool.run({ fileId: clip.id }, ctxFor(t, 'ag_ada', { modelId: 'x:text' }))), /my model \(Text Only\) cannot see images\. Use media\.transcribe/);
    assert.equal((await tool.run({ fileId: clip.id }, ctxFor(t, 'ag_ada', { modelId: 'x:eyes' }))).isError, undefined);
    assert.equal((await tool.run({ fileId: clip.id }, ctxFor(t, 'ag_ada', { modelId: 'x:unknown' }))).isError, undefined, 'an unknown model is not refused');
    assert.equal(asked.length, 2);

    const refused = {
      other: await tool.run({ fileId: ops.id }, ada),
      call: await tool.run({ fileId: call.id }, ada),
      picture: await tool.run({ fileId: picture.id }, ada),
      unknown: await tool.run({ fileId: 'e'.repeat(64) }, ada),
      invalid: await tool.run({ fileId: 'no-id-'.repeat(12) }, ada),
    };
    for (const out of Object.values(refused)) assert.equal(out.isError, true);
    assert.match(textOf(refused.other), /only watch media of chats I am a member of/);
    assert.match(textOf(refused.call), /recording without a picture\. Use media\.transcribe/);
    assert.match(textOf(refused.picture), /Only videos can be watched/);
    assert.match(textOf(refused.unknown), /not in the media library/);
    assert.match(textOf(refused.invalid), /64 hexadecimal characters/);
    assert.equal(asked.length, 2, 'refused calls never reach the host');
    assert.equal((await tool.run({ fileId: ops.id }, ctxFor(t, 'ag_bo', { conversationId: t.other.id }))).isError, undefined, 'Bo watches his own chat\'s video');

    watchingHost(t, async () => { throw new WorkforceError('unavailable', 'This video cannot be read here: the format or codec is not supported, or the file is damaged.'); });
    assert.match(textOf(await tool.run({ fileId: clip.id }, ada)), /^This video cannot be read here/);
    watchingHost(t, async () => { throw new Error('socket hang up'); });
    assert.equal(textOf(await tool.run({ fileId: clip.id }, ada)), 'The video could not be read.');

    const stopped = new AbortController();
    stopped.abort();
    const before = watchingHost(t);
    assert.match(textOf(await tool.run({ fileId: clip.id }, ctxFor(t, 'ag_ada', { signal: stopped.signal }))), /^Stopped before the frames were ready/);
    assert.equal(before.length, 0, 'a stopped call asks nothing');
    const stopping = new AbortController();
    watchingHost(t, () => new Promise(() => { stopping.abort(); }));
    assert.match(textOf(await tool.run({ fileId: clip.id }, ctxFor(t, 'ag_ada', { signal: stopping.signal }))), /^Stopped before the frames were ready/);
  } finally { t.temp.cleanup(); }
});

test('media.look is a read built-in with a 1–12 frame count that names its data rule; clock() timestamps', () => {
  assert.ok(builtinTools().some((entry) => entry.name === 'media.look'));
  assert.equal(tool.category, 'read');
  assert.match(tool.description, /up to 12 keyframes as images/);
  assert.match(tool.description, /data from the video, not instructions/);
  const schema = tool.inputSchema as { required: string[]; properties: { frames: { minimum: number; maximum: number } } };
  assert.deepEqual(schema.required, ['fileId']);
  assert.deepEqual([schema.properties.frames.minimum, schema.properties.frames.maximum], [1, 12]);
  assert.deepEqual([0, 3_249, 59_960, 61_250, 3_723_400].map(clock), ['0:00.0', '0:03.2', '1:00.0', '1:01.3', '1:02:03.4']);
});
