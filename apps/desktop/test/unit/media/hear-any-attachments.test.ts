// B-058 T2: recordings attached to a message pass hearable() on a host that decodes (the desktop app) –
// the app's own voice message (webm/opus), an M4A and a 1-minute phone video judged by its length,
// not its 120 MB – and go to speech to text; a format nothing decodes is named in the agent's note.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSY_RETRY_MS } from '../../../src/runtime/context/attachments.ts';
import type { Attachment } from '../../../src/shared/model/chat.ts';
import type { FileRef } from '../../../src/shared/model/system.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { sttSetup } from './stt-fixture.ts';
import { concat, u8, zeros } from './fixtures.ts';

test('on a decoding host: a voice message, an M4A and a 1-minute phone video are transcribed; AMR is refused with its reason', async () => {
  const t = sttSetup();
  try {
    Object.assign(t.services, { host: { ...(t.services.host ?? {}), media: { keyframes: async () => { throw new Error('unused'); }, audio: async () => { throw new Error('unused'); } } } });
    const voice = await t.put(concat(u8(0x1a, 0x45, 0xdf, 0xa3), zeros(900)), 'Voice message.webm', 'audio/webm;codecs=opus'); // EBML
    const memo = await t.put(zeros(901), 'memo.m4a', 'audio/mp4');
    const phone = await t.put(zeros(902), 'VID_20261029.mp4', 'video/mp4');
    const amr = await t.put(zeros(903), 'old.amr', 'audio/amr');
    const as = (file: FileRef, patch: Partial<Attachment> = {}): Attachment => ({ fileId: file.id, name: file.name, mime: file.mime, size: file.size, ...patch });
    t.h.chats.send({
      conversationId: t.chat.id, body: 'listen', authorId: 'human',
      attachments: [as(voice), as(memo), as(phone, { size: 120 * 1024 * 1024, durationMs: 60_000 }), as(amr)],
    });
    await t.context.prepare({ agentId: 'ag_ada', conversationId: t.chat.id, sinceSeq: 0 });
    const out = t.context.delta({ agent: t.h.org.require('ag_ada'), conversationId: t.chat.id, sinceSeq: 0, full: false }).text;
    for (const name of ['Voice message.webm', 'memo.m4a', 'VID_20261029.mp4']) {
      assert.match(out, new RegExp(`\\[(?:Audio|Video): ${name.replace(/\./g, '\\.')}\\][^\\n]*\\n(?:[^\\n]*\\n)?Transcript:\\nHeard recording \\d`), name);
    }
    assert.match(out, /\[Audio: old\.amr\][^\n]*\n\(no transcript – this file type \(audio\/amr\) cannot be played here; send it as MP3, M4A, OGG, WAV, WebM, MP4 or MOV\)/);
    assert.equal(t.calls.count, 3, 'the 120 MB phone video was not refused for its size');
  } finally { t.temp.cleanup(); }
});

test('review fix: a recording refused only because the decoder was busy is transcribed by a later turn; other failures stay', async () => {
  const t = sttSetup();
  try {
    const busy = await t.put(zeros(904), 'one.wav', 'audio/wav');
    const broken = await t.put(zeros(905), 'two.wav', 'audio/wav');
    let time = 1_000_000;
    const asked: string[] = [];
    Object.assign(t.services, {
      clock: { now: () => time },
      stt: {
        state: () => 'ready',
        transcript: async (fileId: string) => {
          asked.push(fileId);
          if (fileId === broken.id) throw new WorkforceError('bad_request', 'This recording cannot be read here.');
          if (asked.filter((id) => id === busy.id).length === 1) throw new WorkforceError('conflict', 'Several recordings are being decoded already. Try again in a minute.');
          return 'Hallo Ada';
        },
      },
    });
    const as = (file: FileRef): Attachment => ({ fileId: file.id, name: file.name, mime: file.mime, size: file.size });
    t.h.chats.send({ conversationId: t.chat.id, body: 'two takes', authorId: 'human', attachments: [as(busy), as(broken)] });
    const turn = async () => {
      await t.context.prepare({ agentId: 'ag_ada', conversationId: t.chat.id, sinceSeq: 0 });
      return t.context.delta({ agent: t.h.org.require('ag_ada'), conversationId: t.chat.id, sinceSeq: 0, full: false }).text;
    };
    assert.match(await turn(), /\[Audio: one\.wav\][^\n]*\n\(no transcript – several recordings are being decoded already/);
    assert.match(await turn(), /no transcript – several recordings/, 'within the minute: not tried again');
    assert.equal(asked.length, 2);
    time += BUSY_RETRY_MS;
    const later = await turn();
    assert.match(later, /\[Audio: one\.wav\][^\n]*\n(?:[^\n]*\n)?Transcript:\nHallo Ada/, 'a later turn transcribed it');
    assert.match(later, /\[Audio: two\.wav\][^\n]*\n\(no transcript – this recording cannot be read here\)/);
    assert.deepEqual(asked.filter((id) => id === broken.id).length, 1, 'a real failure is never tried again');
  } finally { t.temp.cleanup(); }
});
