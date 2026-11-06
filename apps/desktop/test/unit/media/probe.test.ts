// Media probe (src/runtime/media/probe*.ts): kind from mime, which rows still need a probe,
// and the header parsers – WAV, MP3 (CBR / Xing / VBRI), Ogg Opus, FLAC, MP4 (moov at the
// end, 64-bit mdat, video size, audio-only), WebM (Duration + size; MediaRecorder files
// without Duration via the last cluster), late-SOF JPEG, PDF pages via the injected counter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesSource, kindOf, needsProbe, probeSource } from '../../../src/runtime/media/probe.ts';
import { mp3Duration, wavDuration } from '../../../src/runtime/media/probe-audio.ts';
import { matroskaFacts, mp4Facts } from '../../../src/runtime/media/probe-container.ts';
import { countPdfPages, type PdfPageCounter } from '../../../src/runtime/media/pdf-pages.ts';
import { fakePdf, flac, jpegLateSof, mp3Cbr, mp3Vbri, mp3Xing, mp4, oggOpus, png, realPdf, str, wav, webmRecording, webmWithDuration, zeros } from './fixtures.ts';

const noPdf: { pdfPages: PdfPageCounter } = { pdfPages: async () => undefined };
const probe = (bytes: Uint8Array, mime: string, deps = noPdf) => probeSource(bytesSource(bytes), mime, deps);

test('kindOf maps mime types (parameters ignored) to library kinds', () => {
  assert.equal(kindOf('image/png'), 'image');
  assert.equal(kindOf('audio/webm;codecs=opus'), 'audio');
  assert.equal(kindOf('video/mp4'), 'video');
  assert.equal(kindOf('application/pdf'), 'document');
  assert.equal(kindOf('text/markdown'), 'document');
  assert.equal(kindOf('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'document');
  assert.equal(kindOf('application/zip'), 'other');
  assert.equal(kindOf('application/octet-stream'), 'other');
});

test('needsProbe: only facts the probe can measure and that are still missing', () => {
  assert.equal(needsProbe({ kind: 'image', mime: 'image/png' }), true);
  assert.equal(needsProbe({ kind: 'image', mime: 'image/png', width: 10 }), false);
  assert.equal(needsProbe({ kind: 'image', mime: 'image/heic' }), false);
  assert.equal(needsProbe({ kind: 'audio', mime: 'audio/mpeg' }), true);
  assert.equal(needsProbe({ kind: 'audio', mime: 'audio/mpeg', durationMs: 5 }), false);
  assert.equal(needsProbe({ kind: 'audio', mime: 'audio/aac' }), false);
  assert.equal(needsProbe({ kind: 'audio', mime: 'video/webm' }), true); // audio-only WebM keeps its mime
  assert.equal(needsProbe({ kind: 'document', mime: 'application/pdf' }), true);
  assert.equal(needsProbe({ kind: 'document', mime: 'application/pdf', pages: 2 }), false);
  assert.equal(needsProbe({ kind: 'document', mime: 'text/plain' }), false);
});

test('WAV: data bytes / byte rate, chunks before data are skipped (word aligned)', async () => {
  assert.deepEqual(await probe(wav(2000), 'audio/wav'), { durationMs: 2000 });
  assert.equal(await wavDuration(bytesSource(str('RIFF....AVI '))), undefined);
});

test('MP3: CBR estimate (ID3v2 skipped, ID3v1 excluded), Xing and VBRI frame counts', async () => {
  assert.deepEqual(await probe(mp3Cbr(48000), 'audio/mpeg'), { durationMs: 3000 });
  assert.deepEqual(await probe(mp3Xing(1000), 'audio/mpeg'), { durationMs: 26122 }); // 1000 × 1152 / 44.1 kHz
  assert.deepEqual(await probe(mp3Vbri(500), 'audio/mpeg'), { durationMs: 13061 });
  assert.equal(await mp3Duration(bytesSource(zeros(5000))), undefined);
});

test('Ogg Opus (48 kHz granules minus pre-skip) and FLAC STREAMINFO', async () => {
  assert.deepEqual(await probe(oggOpus(5000), 'audio/ogg'), { durationMs: 5000 });
  assert.deepEqual(await probe(flac(7), 'audio/flac'), { durationMs: 7000 });
});

test('MP4: moov after a 64-bit mdat gives duration and video size; audio-only video/mp4 becomes audio', async () => {
  assert.deepEqual(await probe(mp4({ durationMs: 12345, video: { width: 1920, height: 1080 } }), 'video/mp4'), { durationMs: 12345, width: 1920, height: 1080 });
  assert.deepEqual(await probe(mp4({ durationMs: 4000 }), 'video/mp4'), { durationMs: 4000, kind: 'audio' });
  assert.deepEqual(await probe(mp4({ durationMs: 4000 }), 'audio/mp4'), { durationMs: 4000 });
  assert.equal(await mp4Facts(bytesSource(zeros(64))), undefined);
});

test('WebM: Info Duration and pixel size; MediaRecorder audio without Duration uses the last cluster', async () => {
  assert.deepEqual(await probe(webmWithDuration(4321), 'video/webm'), { durationMs: 4321, width: 1280, height: 720 });
  const recording = webmRecording([{ timecode: 0, blocks: [0, 20, 40] }, { timecode: 2500, blocks: [0, 250, 500] }]);
  assert.deepEqual(await probe(recording, 'video/webm'), { durationMs: 3000, kind: 'audio' });
  assert.deepEqual(await probe(recording, 'audio/webm'), { durationMs: 3000 });
  assert.equal(await matroskaFacts(bytesSource(png(1, 1))), undefined);
});

test('images: header size, also when the JPEG frame header sits beyond 64 KiB', async () => {
  assert.deepEqual(await probe(png(640, 480), 'image/png'), { width: 640, height: 480 });
  assert.deepEqual(await probe(jpegLateSof(4000, 3000), 'image/jpeg'), { width: 4000, height: 3000 });
  assert.deepEqual(await probe(png(1, 1), 'image/heic'), {});
});

test('PDF pages come from the injected counter; unknown types and garbage yield no facts', async () => {
  let seen = 0;
  const facts = await probe(fakePdf(), 'application/pdf', { pdfPages: async (bytes) => { seen = bytes.length; return 12; } });
  assert.deepEqual(facts, { pages: 12 });
  assert.equal(seen, fakePdf().length);
  assert.deepEqual(await probe(fakePdf(), 'application/pdf'), {});
  assert.deepEqual(await probe(zeros(100), 'application/zip'), {});
  assert.deepEqual(await probe(zeros(100), 'video/mp4'), {});
  assert.deepEqual(await probe(zeros(100), 'audio/wav'), {});
});

test('countPdfPages: real pdf.js page count; damaged PDFs give undefined instead of throwing', async () => {
  assert.equal(await countPdfPages(realPdf(3)), 3);
  assert.equal(await countPdfPages(str('%PDF-1.4 garbage')), undefined);
});
