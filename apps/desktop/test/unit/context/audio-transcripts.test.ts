// Agents hear recordings (MM1): audio/video attachments reach delta() with duration, the media
// library's description/tags and a transcript from RuntimeServices.stt (real Transcriber, fake
// fetch for /audio/transcriptions). Covers: pending on the first delta like a PDF, transcript on
// the next, redaction before caching, the cache (no second request, also after a restart), the
// hint without speech to text or when it is off, remembered failures, one transcription at a
// time, video labels and (B-058 T2) the hearable() gate without a decoding host.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../../../src/runtime/context/service.ts';
import { durationText, RECORDING_DATA_NOTE } from '../../../src/runtime/context/render.ts';
import { NO_TRANSCRIPT } from '../../../src/runtime/context/attachments.ts';
import { FileRepo } from '../../../src/runtime/store/files.ts';
import type { Attachment } from '../../../src/shared/model/chat.ts';
import type { FileRef } from '../../../src/shared/model/system.ts';
import { concat, mp4, u8, wav, zeros } from '../media/fixtures.ts';
import { sttSetup, transcriptResponse } from '../media/stt-fixture.ts';

type Setup = ReturnType<typeof sttSetup>;

const delta = (t: Setup, sinceSeq = 0, context = t.context) =>
  context.delta({ agent: t.h.org.require('ag_ada'), conversationId: t.chat.id, sinceSeq, full: false });

const send = (t: Setup, ...attachments: Attachment[]) =>
  t.h.chats.send({ conversationId: t.chat.id, body: 'listen', authorId: 'human', attachments });

const asAttachment = (file: FileRef, patch: Partial<Attachment> = {}): Attachment => ({ fileId: file.id, name: file.name, mime: file.mime, size: file.size, ...patch });

test('a voice note is pending on the first delta and carries duration, description and the redacted transcript on the next', async () => {
  const t = sttSetup({ respond: () => transcriptResponse('Book the venue for Friday. The door code is hunter2.') });
  try {
    const file = await t.put(wav(2000), 'memo.wav', 'audio/wav');
    await t.media.idle(); // duration measured by the media library
    t.media.describe(file.id, { description: 'Voice memo about the venue', tags: ['venue', 'friday'] }, 'human');
    const message = t.attach(t.chat.id, file);

    const first = delta(t);
    assert.match(first.text, /\[Audio: memo\.wav\] \(audio\/wav, 31 KB, 0:02, stored at .*[a-f0-9]{64}\)/);
    assert.ok(first.text.includes('(Transcription is still running; the transcript follows in a later turn.)'));
    assert.equal(first.lastSeq, message.seq - 1, 'the message stays unseen until its transcript is there');

    await t.context.prepare({ agentId: 'ag_ada', conversationId: t.chat.id, sinceSeq: first.lastSeq }); // awaits the transcription delta() started
    const second = delta(t, first.lastSeq);
    assert.equal(second.lastSeq, message.seq);
    const lines = second.text.split('\n');
    const header = lines.findIndex((line) => line.startsWith('[Audio: memo.wav]'));
    assert.deepEqual(lines.slice(header + 1), [
      RECORDING_DATA_NOTE,
      'Description: Voice memo about the venue',
      'Tags: venue, friday',
      'Transcript:',
      'Book the venue for Friday. The door code is secret://sec_pw.',
    ]);
    assert.equal(new FileRepo(t.h.db).cachedText(file.id), 'Book the venue for Friday. The door code is secret://sec_pw.', 'redacted before caching');
    assert.equal(t.calls.count, 1);
    assert.deepEqual(t.calls.urls, ['http://127.0.0.1:9100/v1/audio/transcriptions']);
    assert.deepEqual(t.calls.models, ['whisper-1']);

    // Cache hit: a new context (runtime restart) and prepare() make no second request.
    const restarted = new Context({ services: () => t.services, runner: false });
    await restarted.prepare({ agentId: 'ag_ada', conversationId: t.chat.id, sinceSeq: 0 });
    assert.ok(delta(t, 0, restarted).text.includes('Transcript:\nBook the venue for Friday.'));
    assert.equal(t.calls.count, 1);
  } finally { t.temp.cleanup(); }
});

test('prepare() transcribes before the turn, so the first delta already has the transcript', async () => {
  const t = sttSetup();
  try {
    const file = await t.put(wav(1000), 'note.wav', 'audio/wav');
    const message = t.attach(t.chat.id, file);
    await t.context.prepare({ agentId: 'ag_ada', conversationId: t.chat.id, sinceSeq: 0 });
    const out = delta(t);
    assert.ok(out.text.includes('Transcript:\nHeard recording 1'));
    assert.equal(out.lastSeq, message.seq);
    assert.equal(t.calls.count, 1);
  } finally { t.temp.cleanup(); }
});

test('without speech to text the agent gets one hint line, nothing is pending and nothing is sent; "off" disables it', async () => {
  for (const [state, note] of [['missing', NO_TRANSCRIPT.missing], ['off', NO_TRANSCRIPT.off]] as const) {
    const t = sttSetup({ stt: state });
    try {
      const file = await t.put(wav(1000), 'note.wav', 'audio/wav');
      const message = t.attach(t.chat.id, file);
      await t.context.prepare({ agentId: 'ag_ada', conversationId: t.chat.id, sinceSeq: 0 });
      const out = delta(t);
      assert.ok(out.text.includes(`(${note})`), out.text);
      assert.ok(!out.text.includes(RECORDING_DATA_NOTE), 'no data note without description or transcript');
      assert.equal(out.lastSeq, message.seq);
      assert.equal(t.calls.count, 0);
    } finally { t.temp.cleanup(); }
  }
  assert.equal(NO_TRANSCRIPT.missing, 'no transcript – speech to text is not set up');
});

test('a failed transcription is remembered (no retry loop); media.transcribe can still fill it later', async () => {
  let fail = true;
  const t = sttSetup({ respond: () => (fail ? new Response('{"error":"bad"}', { status: 500 }) : transcriptResponse('Second try worked')) });
  try {
    const file = await t.put(wav(1000), 'note.wav', 'audio/wav');
    const message = t.attach(t.chat.id, file);
    await t.context.prepare({ agentId: 'ag_ada', conversationId: t.chat.id, sinceSeq: 0 });
    const out = delta(t);
    assert.match(out.text, /\(no transcript – the transcription service did not accept the audio\. Check the speech-to-text model/);
    assert.equal(out.lastSeq, message.seq, 'a failure is not pending');
    await t.context.prepare({ agentId: 'ag_ada', conversationId: t.chat.id, sinceSeq: 0 });
    delta(t);
    assert.equal(t.calls.count, 1, 'no second request for a remembered failure');

    fail = false;
    assert.equal(await t.stt.transcript(file.id), 'Second try worked'); // what media.transcribe calls
    assert.ok(delta(t).text.includes('Transcript:\nSecond try worked'), 'a later transcript replaces the remembered failure');
    assert.equal(t.calls.count, 2);
  } finally { t.temp.cleanup(); }
});

test('recordings are transcribed one at a time, each once', async () => {
  const t = sttSetup();
  try {
    const a = await t.put(wav(1000), 'a.wav', 'audio/wav');
    const b = await t.put(wav(1200), 'b.wav', 'audio/wav');
    const c = await t.put(wav(1400), 'c.wav', 'audio/wav');
    t.attach(t.chat.id, a, b);
    t.attach(t.chat.id, c);
    const first = delta(t); // starts all three in the background
    assert.equal(first.lastSeq, 0);
    delta(t); // still running: no duplicate jobs
    await Promise.all([a, b, c].map((file) => t.stt.transcript(file.id)));
    const out = delta(t);
    assert.equal(t.calls.count, 3);
    assert.equal(t.calls.maxActive, 1);
    assert.equal((out.text.match(/Transcript:\nHeard recording \d/g) ?? []).length, 3);
    assert.equal(out.lastSeq, 2);
  } finally { t.temp.cleanup(); }
});

test('video label; without a decoding host (B-058 T2 hearable): a format no service takes is refused, a long WAV is heard', async () => {
  const t = sttSetup();
  try {
    const clip = await t.put(mp4({ durationMs: 4000, video: { width: 640, height: 360 } }), 'clip.mp4', 'video/mp4');
    const aac = await t.put(concat(u8(0xff, 0xf1, 0x50, 0x80), zeros(64)), 'voice.aac', 'audio/aac'); // ADTS AAC
    await t.media.idle();
    const long = await t.put(wav(500), 'long.wav', 'audio/wav');
    const message = send(t, asAttachment(clip), asAttachment(aac), asAttachment(long, { size: 26 * 1024 * 1024, durationMs: 3_725_000 }));
    await t.context.prepare({ agentId: 'ag_ada', conversationId: t.chat.id, sinceSeq: 0 });
    const out = delta(t);
    assert.match(out.text, /\[Video: clip\.mp4\] \(video\/mp4, \d+ B, 0:04, stored at /);
    assert.ok(out.text.includes('Transcript:\nHeard recording 1'));
    assert.match(out.text, /\[Audio: voice\.aac\][^\n]*\n\(no transcript – only WAV recordings can be heard here; this format needs the desktop app\)/);
    assert.match(out.text, /\[Audio: long\.wav\] \(audio\/wav, 26\.0 MB, 1:02:05, [^\n]*\n[^\n]*\nTranscript:\nHeard recording 2/, 'its length counts, not its 26 MB');
    assert.equal(out.lastSeq, message.seq);
    assert.equal(t.calls.count, 2, 'the video and the long WAV were sent');
  } finally { t.temp.cleanup(); }
});

test('durations read like a clock', () => {
  assert.equal(durationText(42_000), '0:42');
  assert.equal(durationText(725_400), '12:05');
  assert.equal(durationText(3_723_000), '1:02:03');
});
