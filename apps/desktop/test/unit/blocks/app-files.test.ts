// Mini-app file hand-back policy (X03, shared/blocks/app-files.ts): which types a to-do app may
// hand back, how a type and a name are normalized, the refusal texts both sides show, the
// mini-app guide's wf.upload bullet (the short prompt keeps its budget) and the blocks.file RPC
// shape merged into Methods.
// Owns: these assertions only. Never: bytes, RPC or the file store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParamsOf, ResultOf } from '../../../src/shared/api/methods.ts';
import {
  APP_TYPE_REFUSAL, APP_UPLOAD_LIMITS, APP_UPLOAD_TYPES, appBlockRefusal, appFileRefusal, appUploadMime, appUploadName, sizeText,
} from '../../../src/shared/blocks/app-files.ts';
import { blockHelp, blockPrompt } from '../../../src/shared/blocks/prompt.ts';

const MB = 1024 * 1024;

test('appUploadMime: bare lower-case types, aliases, the extension when the type is empty, nothing else', () => {
  assert.equal(appUploadMime('audio/webm;codecs=opus'), 'audio/webm');
  assert.equal(appUploadMime(' Audio/WAV '), 'audio/wav');
  assert.equal(appUploadMime('audio/x-wav'), 'audio/wav');
  assert.equal(appUploadMime('audio/wave'), 'audio/wav');
  assert.equal(appUploadMime('audio/mp3'), 'audio/mpeg');
  assert.equal(appUploadMime('audio/x-m4a'), 'audio/mp4');
  assert.equal(appUploadMime('', 'take.wav'), 'audio/wav');
  assert.equal(appUploadMime('', 'clip.MP4'), 'video/mp4', 'the type an extension is the default of');
  assert.equal(appUploadMime('', 'notes.md'), 'text/markdown');
  assert.equal(appUploadMime('', 'take'), undefined);
  assert.equal(appUploadMime('', 'page.html'), undefined);
  for (const type of ['text/html', 'image/svg+xml', 'application/javascript', 'text/javascript', 'application/zip', 'application/octet-stream']) {
    assert.equal(appUploadMime(type, 'take.wav'), undefined, `${type} is never allowed, whatever the name says`);
  }
  for (const mime of ['image/svg+xml', 'text/html', 'application/zip', 'application/octet-stream']) assert.equal(Object.hasOwn(APP_UPLOAD_TYPES, mime), false);
});

test('appUploadName: base name only, unsafe characters replaced, the extension of the type', () => {
  assert.equal(appUploadName('../../evil.bat', 'text/plain'), 'evil.txt');
  assert.equal(appUploadName('C:\\Users\\me\\take.wav', 'audio/wav'), 'take.wav');
  assert.equal(appUploadName(undefined, 'audio/webm'), 'file.webm');
  assert.equal(appUploadName(42, 'image/png'), 'file.png');
  assert.equal(appUploadName('take', 'audio/webm'), 'take.webm');
  assert.equal(appUploadName('a.webm', 'video/webm'), 'a.webm');
  assert.equal(appUploadName('Photo.JPEG', 'image/jpeg'), 'Photo.jpeg');
  assert.equal(appUploadName('...hidden', 'text/plain'), 'hidden.txt');
  assert.equal(appUploadName('a<b>:c"d|e?f*g', 'text/plain'), 'a_b__c_d_e_f_g.txt');
  assert.equal(appUploadName('line\nbreak\u0007.wav', 'audio/wav'), 'line_break_.wav');
  assert.equal(appUploadName('take\u202Evaw.exe', 'audio/wav'), 'take_vaw.wav', 'no bidi override that makes a name read backwards');
  assert.equal(appUploadName('Interview 2026.10.21', 'audio/wav'), 'Interview 2026.10.21.wav', 'digits are no extension');
  assert.equal(appUploadName('  .  ', 'audio/wav'), 'file.wav');
  const long = appUploadName(`${'x'.repeat(300)}.wav`, 'audio/wav');
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('.wav'));
});

test('appFileRefusal: empty, too large, a type or an extension that is not allowed', () => {
  assert.equal(appFileRefusal({ name: 'take.wav', mime: 'audio/wav', size: 3_244 }), undefined);
  assert.equal(appFileRefusal({ name: 'take.wav', mime: 'audio/wav', size: 0 }), 'The file is empty.');
  assert.equal(appFileRefusal({ name: 'take.wav', mime: 'audio/wav', size: 100 * MB + 1 }), 'Files from a mini-app can be at most 100 MB.');
  assert.equal(appFileRefusal({ name: 'take.wav', mime: 'audio/wav', size: 100 * MB }), undefined, 'exactly the limit is fine');
  for (const file of [
    { name: 'logo.svg', mime: 'image/svg+xml' }, { name: 'page.html', mime: 'text/html' }, { name: 'blob.bin', mime: 'application/octet-stream' },
    { name: 'take.zip', mime: 'application/zip' }, { name: 'evil.bat', mime: 'text/plain' }, { name: 'take', mime: 'audio/wav' },
    { name: 'take.mp3', mime: 'audio/wav' },
  ]) {
    assert.equal(appFileRefusal({ ...file, size: 10 }), APP_TYPE_REFUSAL, file.name);
  }
  assert.equal(APP_TYPE_REFUSAL, 'Mini-apps can hand back audio, video, images, PDFs and text files.');
  // The store sniffs every WebM as video/webm and many MP4 as video/mp4: the audio twin's extensions still count.
  assert.equal(appFileRefusal({ name: 'take.weba', mime: 'video/webm', size: 10 }), undefined);
  assert.equal(appFileRefusal({ name: 'take.m4a', mime: 'video/mp4', size: 10 }), undefined);
  assert.equal(appFileRefusal({ name: 'take.mov', mime: 'audio/mp4', size: 10 }), APP_TYPE_REFUSAL, 'only the twin of the same container');
  const small = { fileBytes: 1024, blockBytes: 4096, filesPerBlock: 2 };
  assert.equal(appFileRefusal({ name: 'take.wav', mime: 'audio/wav', size: 2048 }, small), 'Files from a mini-app can be at most 1 KB.');
});

test('appBlockRefusal: ten files and 300 MB per block', () => {
  assert.equal(appBlockRefusal({ count: 9, bytes: 0 }, 1), undefined);
  assert.equal(appBlockRefusal({ count: 10, bytes: 0 }, 1), 'This mini-app already stored 10 files.');
  assert.equal(appBlockRefusal({ count: 2, bytes: 250 * MB }, 50 * MB), undefined);
  assert.equal(appBlockRefusal({ count: 2, bytes: 250 * MB }, 50 * MB + 1), 'This mini-app already stored 300 MB.');
  assert.deepEqual(APP_UPLOAD_LIMITS, { fileBytes: 100 * MB, blockBytes: 300 * MB, filesPerBlock: 10 });
  assert.equal(sizeText(100 * MB), '100 MB');
  assert.equal(sizeText(1.5 * MB), '1.5 MB');
  assert.equal(sizeText(2048), '2 KB');
});

test('the mini-app guide teaches wf.upload; the short prompt keeps its budget', () => {
  const guide = blockHelp('app');
  assert.match(guide, /wf\.upload\(blob, name\)/);
  assert.match(guide, /≤ 100 MB/);
  assert.match(guide, /≤ 10 per app/);
  assert.match(guide, /wf\.complete\(\{take\}\)/);
  assert.match(guide, /arrives attached to the person's line, with where it is stored/);
  assert.match(guide, /naming none hands\n {2}back all/);
  assert.match(guide, /permissions="microphone"/);
  for (const prompt of [blockPrompt({ tier: 'full' }), blockPrompt({ tier: 'full', helpTool: 'ui__help' })]) {
    assert.ok(Math.ceil(prompt.length / 4) < 600, `~${Math.ceil(prompt.length / 4)} tokens`);
    assert.doesNotMatch(prompt, /wf\.upload/, 'the short prompt points to the guide instead');
  }
});

test('blocks.file is part of Methods (module augmentation)', () => {
  const params: ParamsOf<'blocks.file'> = { messageId: 'msg_0123456789', blockIndex: 0, fileId: 'a'.repeat(64) };
  const result: ResultOf<'blocks.file'> = { file: { id: params.fileId, name: 'take.wav', mime: 'audio/wav', size: 10, createdAt: 0 }, count: 1, bytes: 10 };
  assert.equal(result.file.id, params.fileId);
});
