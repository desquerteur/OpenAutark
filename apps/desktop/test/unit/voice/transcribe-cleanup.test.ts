// SM9 privacy with the real blob store and clean-up (files/store.ts, files/cleanup.ts): a heard
// dictation take (voice.transcribe → Transcriber.transcribe, fake fetch) leaves the store and the
// media library once the hold after the answer ends; a take the client attached to its draft
// after losing the answer – also one whose transcription took longer than the 60 s grace – or one
// a message carries stays; a take the client stores again comes back under the same id; an older
// library recording a chat device names is heard but never queued.
// Owns: these assertions only. Never: a real provider (fetch is a fake), real timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { CleanupTimers } from '../../../src/runtime/files/cleanup.ts';
import { Blobs } from '../../../src/runtime/files/store.ts';
import { withMediaHook } from '../../../src/runtime/media/hook.ts';
import { MediaService } from '../../../src/runtime/media/service.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { FRESH_TAKE_MS, HEARD_TAKE_HOLD_MS, Transcriber } from '../../../src/runtime/voice/transcribe.ts';
import type { Attachment } from '../../../src/shared/model/chat.ts';
import type { Account, ModelInfo } from '../../../src/shared/model/providers.ts';
import type { FileRef } from '../../../src/shared/model/system.ts';
import { agent, harness } from '../chat/harness.ts';
import { tempDir } from '../store/helpers.ts';

class FakeTimers implements CleanupTimers {
  armed: Array<{ fn: () => void; ms: number; id: number }> = [];
  private seq = 0;
  setTimeout(fn: () => void, ms: number): unknown { const id = ++this.seq; this.armed.push({ fn, ms, id }); return id; }
  clearTimeout(handle: unknown): void { this.armed = this.armed.filter((timer) => timer.id !== handle); }
  fire(): void {
    assert.equal(this.armed.length, 1, 'exactly one timer is armed');
    const [timer] = this.armed;
    this.armed = [];
    timer.fn();
  }
}

const ACCOUNT = { id: 'acc_1', provider: 'compatible', label: 'STT', auth: 'api_key', baseUrl: 'https://stt.example/v1', state: 'ok', priority: 0, rotation: false, enabled: true, detected: false, createdAt: 1 } as Account;
const MODEL = { id: 'compatible:whisper-1', provider: 'compatible', model: 'whisper-1', name: 'whisper-1', engine: 'compatible', efforts: [], caps: {}, tier: 'strong', strengths: {}, available: true, accounts: [ACCOUNT.id], functions: ['stt'] } as ModelInfo;

function setup(transcriptionMs = 0) {
  const h = harness();
  const temp = tempDir();
  const log = new MemoryLogger();
  const timers = new FakeTimers();
  const blobs = new Blobs({ db: h.db, blobs: path.join(temp.dir, 'blobs'), clock: h.clock, log, timers });
  const media = new MediaService({ services: () => h.services, pdfPages: async () => undefined });
  h.services.files = withMediaHook(blobs, (file) => media.onFileStored(file), log);
  h.org.add(agent('ag_ada', 'Ada'));
  const chat = h.chats.create({ title: 'Brand', agentIds: ['ag_ada'], createdBy: 'human' });
  const stt = {
    ...h.services,
    settings: { get: () => ({ voice: { vocabulary: [] }, routing: { functions: {} } }) },
    catalog: { list: () => [MODEL] },
    accounts: { get: () => ACCOUNT, candidates: () => [ACCOUNT], apiKey: async () => undefined },
  } as unknown as RuntimeServices;
  const transcriber = new Transcriber({
    services: () => stt,
    fetch: async () => { h.clock.advance(transcriptionMs); return new Response(JSON.stringify({ text: ' Call Anna back. ' })); },
  });
  /** One recorded take (webm header, then bytes of its own), uploaded like files.upload does. */
  const take = (n: number) => h.services.files.put(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, n]), `Dictation ${n}.webm`, 'audio/webm');
  const toAttachment = (file: FileRef): Attachment => ({ fileId: file.id, name: file.name, mime: file.mime, size: file.size });
  const settle = async () => { await blobs.cleanup.idle(); await media.idle(); };
  const gone = (id: string) => !existsSync(blobs.path(id)) && !blobs.get(id) && !media.get(id);
  const kept = (id: string) => existsSync(blobs.path(id)) && Boolean(blobs.get(id)) && Boolean(media.get(id));
  return { h, temp, timers, blobs, chat, transcriber, take, toAttachment, settle, gone, kept };
}

test('a heard take leaves the store and the media library after the hold; a drafted or sent take stays', async () => {
  const s = setup(90_000); // each transcription takes longer than the 60 s upload grace
  try {
    const heard = await s.take(1);
    const drafted = await s.take(2);
    const sent = await s.take(3);
    for (const file of [heard, drafted, sent]) assert.equal((await s.transcriber.transcribe({ fileId: file.id })).text, 'Call Anna back.');
    assert.equal(s.blobs.cleanup.queued(), 3);
    await s.settle();
    assert.ok([heard, drafted, sent].every((file) => s.kept(file.id)), 'nothing goes right after the answer');
    assert.deepEqual(s.timers.armed.map((timer) => timer.ms), [HEARD_TAKE_HOLD_MS], 'one timer, due when the hold of the first take ends');

    // The answer for `drafted` was lost with the connection: minutes later the composer attaches the take and saves its draft.
    s.h.clock.advance(5 * 60_000);
    s.h.chats.saveDraft(s.chat.id, '', [s.toAttachment(drafted)]);
    s.h.chats.send({ conversationId: s.chat.id, body: 'voice note', authorId: 'human', attachments: [s.toAttachment(sent)] });
    s.h.clock.advance(HEARD_TAKE_HOLD_MS);
    s.timers.fire();
    await s.settle();
    assert.ok(s.gone(heard.id), 'blob, files row and media row of the heard take are gone');
    assert.ok(s.kept(drafted.id), 'the draft holds the take it attached');
    assert.ok(s.kept(sent.id), 'a message holds the take it carries');
    assert.equal(s.blobs.cleanup.queued(), 0);
    assert.equal(s.timers.armed.length, 0, 'no timer stays armed for an empty queue');
  } finally { s.temp.cleanup(); }
});

test('a take the client stores again after a lost answer comes back under the same id, and its draft keeps it', async () => {
  const s = setup();
  try {
    const file = await s.take(4);
    await s.transcriber.transcribe({ fileId: file.id });
    await s.settle();
    s.h.clock.advance(HEARD_TAKE_HOLD_MS);
    s.timers.fire();
    await s.settle();
    assert.ok(s.gone(file.id), 'nothing attached it within the hold');

    // The phone was locked for an hour: it stores the take again (endpoint-dictation.ts), then saves the draft.
    s.h.clock.advance(60 * 60_000);
    const again = await s.take(4);
    assert.equal(again.id, file.id, 'the same bytes, the same id: the attachment stays valid');
    s.h.chats.saveDraft(s.chat.id, '', [s.toAttachment(again)]);
    await s.settle();
    assert.ok(s.kept(file.id));
    assert.equal(s.blobs.cleanup.queued(), 0, 'a stored file is not queued: only the draft decides now');
  } finally { s.temp.cleanup(); }
});

test('an older library recording that a chat device has transcribed is never queued', async () => {
  const s = setup();
  try {
    const recording = await s.take(5);
    s.h.clock.advance(FRESH_TAKE_MS + 1000);
    assert.equal((await s.transcriber.transcribe({ fileId: recording.id })).text, 'Call Anna back.');
    await s.settle();
    assert.equal(s.blobs.cleanup.queued(), 0);
    assert.equal(s.timers.armed.length, 0);
    assert.ok(s.kept(recording.id));
  } finally { s.temp.cleanup(); }
});
