// B-078 (live analysis 06.11.): dictation becomes text (runtime/media/dictation.ts) – a person's message that is only a
// recording gets the (redacted) transcript as its body, marked meta.dictation, once; the agents' context reads that
// text and the attachment only says so (no second transcription); a message with words of its own stays as it is;
// without speech to text nothing changes; a quick task posted with only a recording gets its title from the transcript;
// a message another PC wrote (its recording's bytes not here) is left to that PC and read by its synced meta.dictation.
// Owns: these assertions only. Never: a network, real timers beyond setImmediate, or a real engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import type { Attachment } from '../../../src/shared/model/chat.ts';
import type { FileRef } from '../../../src/shared/model/system.ts';
import { ORIGINS } from '../../../src/shared/model/origin.ts';
import { DICTATED } from '../../../src/runtime/context/attachments.ts';
import { Dictation, dictated, RETRY_MS } from '../../../src/runtime/media/dictation.ts';
import { QUICK_POST_NS } from '../../../src/runtime/tasks/quick.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { MessageRepo } from '../../../src/runtime/chat/message-repo.ts';
import { sttSetup, transcriptResponse } from './stt-fixture.ts';
import { wav } from './fixtures.ts';

type Setup = ReturnType<typeof sttSetup>;
const asAttachment = (file: FileRef): Attachment => ({ fileId: file.id, name: file.name, mime: file.mime, size: file.size });
const voice = (t: Setup, file: FileRef, body = '') => t.h.chats.send({ conversationId: t.chat.id, body, authorId: 'human', attachments: [asAttachment(file)] });

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(label);
}

test('a voice message becomes its own text, marked as dictation; the agents read that text, not the recording again', async () => {
  const t = sttSetup({ respond: () => transcriptResponse('Please book the venue for Friday. The code is hunter2.') });
  try {
    const file = await t.put(wav(2000), 'voice.wav', 'audio/wav');
    const message = voice(t, file);
    await until(() => Boolean(t.h.chats.message(message.id)?.body), 'the transcript arrives in the body');
    const stored = t.h.chats.message(message.id)!;
    assert.equal(stored.body, 'Please book the venue for Friday. The code is secret://sec_pw.', 'redacted');
    assert.deepEqual(stored.meta.dictation, { fileId: file.id });
    assert.equal(dictated(t.h.db, file.id), true);
    assert.ok(t.h.of('message.updated').some((event) => (event as { id: string }).id === message.id));
    await t.context.prepare({ agentId: 'ag_ada', conversationId: t.chat.id, sinceSeq: 0 });
    const delta = t.context.delta({ agent: t.h.org.require('ag_ada'), conversationId: t.chat.id, sinceSeq: 0, full: false });
    assert.match(delta.text, /Please book the venue for Friday/);
    assert.ok(delta.text.includes(`(${DICTATED})`), 'the attachment only says where its words are');
    assert.equal(delta.text.match(/Please book the venue/g)?.length, 1, 'the words once');
    assert.equal(t.calls.count, 1, 'one transcription for everyone');
  } finally { t.temp.cleanup(); }
});

test('a message with its own words, or without speech to text, stays as it is', async () => {
  const t = sttSetup({ respond: () => transcriptResponse('heard') });
  const off = sttSetup({ stt: 'missing' });
  try {
    const file = await t.put(wav(1000), 'note.wav', 'audio/wav');
    const typed = voice(t, file, 'listen to this');
    const quiet = voice(off, await off.put(wav(1000), 'note.wav', 'audio/wav'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(t.h.chats.message(typed.id)!.body, 'listen to this');
    assert.equal(off.h.chats.message(quiet.id)!.body, '');
    assert.equal(off.calls.count, 0);
    assert.deepEqual(off.h.chats.message(quiet.id)!.meta.dictation, { fileId: (quiet.attachments ?? [])[0].fileId, failed: true }, 'nothing waits for it');
  } finally { t.temp.cleanup(); off.temp.cleanup(); }
});

test('a recording that yields no words is marked as heard-nothing at once: the held line goes out, agents read the recording', async () => {
  const t = sttSetup({ respond: () => transcriptResponse('   ') });
  try {
    const file = await t.put(wav(1000), 'silence.wav', 'audio/wav');
    const message = voice(t, file);
    await until(() => Boolean(t.h.chats.message(message.id)?.meta.dictation), 'the end is marked');
    const stored = t.h.chats.message(message.id)!;
    assert.equal(stored.body, '');
    assert.deepEqual(stored.meta.dictation, { fileId: file.id, failed: true });
    assert.equal(dictated(t.h.db, file.id), false, 'no transcript in the body');
    assert.ok(t.h.of('message.updated').some((event) => (event as { id: string }).id === message.id), 'the waiting delivery hears it');
  } finally { t.temp.cleanup(); }
});

test('a quick task posted with only a recording gets its title and notes from the transcript', async () => {
  const t = sttSetup({ respond: () => transcriptResponse('Call the printer about the flyers. They are late again.') });
  try {
    const file = await t.put(wav(1000), 'memo.wav', 'audio/wav');
    const task = t.h.tasks.create({ title: 'memo.wav', origin: ORIGINS.intake, assigneeKind: 'team', createdBy: 'human' });
    new KvRepo(t.h.db).set(QUICK_POST_NS, task.id, { attachments: [asAttachment(file)] }, 1);
    await until(() => t.h.tasks.get(task.id)!.title !== 'memo.wav', 'the title follows the transcript');
    const renamed = t.h.tasks.get(task.id)!;
    assert.equal(renamed.title, 'Call the printer about the flyers.');
    assert.equal(renamed.notes, 'Call the printer about the flyers. They are late again.');
  } finally { t.temp.cleanup(); }
});

test('a message another PC wrote is transcribed there: here its synced body is read as the text, nothing is pulled or heard', async () => {
  const t = sttSetup({ respond: () => transcriptResponse('heard twice') });
  try {
    const file = await t.put(wav(1000), 'far.wav', 'audio/wav');
    const waits: number[] = [];
    let pulls = 0;
    const services = t.services;
    rmSync(services.files.path(file.id)); // a synced row brings the files row, not the bytes
    Object.assign(services, { devices: { list: () => [], online: () => false, call: async () => { pulls++; return undefined; }, self: () => ({ id: 'dev_self' }) } });
    const dictation = new Dictation({ services: () => services, later: (_fn, ms) => { waits.push(ms); } });
    const message = t.h.chats.send({ conversationId: t.chat.id, body: '', authorId: 'human', attachments: [asAttachment(file)] });
    dictation.onMessage(message);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(waits, [], 'no waits for bytes another PC holds');
    assert.equal(t.calls.count, 0, 'not transcribed here');
    assert.equal(t.h.chats.message(message.id)!.body, '');
    assert.equal(dictated(t.h.db, file.id), false);
    // The writing PC's transcript arrives with the row (meta.dictation travels; nothing local marks it).
    const row = new MessageRepo(t.h.db).get(message.id)!;
    new MessageRepo(t.h.db).update({ ...row, body: 'Words from the other PC.', meta: { ...row.meta, dictation: { fileId: file.id } } });
    assert.equal(dictated(t.h.db, file.id), true);
    await t.context.prepare({ agentId: 'ag_ada', conversationId: t.chat.id, sinceSeq: 0 });
    const delta = t.context.delta({ agent: t.h.org.require('ag_ada'), conversationId: t.chat.id, sinceSeq: 0, full: false });
    assert.match(delta.text, /Words from the other PC/);
    assert.ok(delta.text.includes(`(${DICTATED})`));
    assert.equal(t.calls.count, 0, 'no second transcription');
    assert.equal(pulls, 0, 'no pull for a dictated recording');
    assert.equal(RETRY_MS.length, 5);
  } finally { t.temp.cleanup(); }
});
