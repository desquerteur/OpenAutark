// MM6 blob clean-up (src/runtime/files/cleanup.ts, references.ts, Blobs.remove/reclaim and the
// chat triggers): deleting a message or a chat frees the files nothing else uses – blob, files
// row, media row and its search entry – after the 60 s grace; a draft change never does (the
// composer clears its draft before messages.send arrives); a link in a text keeps a file; every other
// use keeps a file; a row of a deleted chat moves to the chat that still uses it; busy files
// back off; the start-up reconcile finishes a queue a quit interrupted, files of chats deleted
// before MM6 and old temp parts. One fake timer at most – none left once the queue is empty.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CleanupTimers } from '../../../src/runtime/files/cleanup.ts';
import { BlobCleanup, graceFromEnv, reclaimerOf } from '../../../src/runtime/files/cleanup.ts';
import { fileUses, firstUse, isBusy } from '../../../src/runtime/files/references.ts';
import { Blobs } from '../../../src/runtime/files/store.ts';
import { withMediaHook } from '../../../src/runtime/media/hook.ts';
import { MediaService } from '../../../src/runtime/media/service.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import type { Attachment } from '../../../src/shared/model/chat.ts';
import type { FileRef } from '../../../src/shared/model/system.ts';
import { agent, harness } from '../chat/harness.ts';
import { tempDir } from '../store/helpers.ts';

const F = '```';

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

function setup() {
  const h = harness();
  const temp = tempDir();
  const log = new MemoryLogger();
  const timers = new FakeTimers();
  const dir = path.join(temp.dir, 'blobs');
  const blobs = new Blobs({ db: h.db, blobs: dir, clock: h.clock, log, timers });
  const media = new MediaService({ services: () => h.services, pdfPages: async () => undefined });
  h.services.files = withMediaHook(blobs, (file) => media.onFileStored(file), log);
  h.org.add(agent('ag_ada', 'Ada'));
  const chat = h.chats.create({ title: 'Brand', agentIds: ['ag_ada'], createdBy: 'human' });
  const other = h.chats.create({ title: 'Ops', agentIds: ['ag_ada'], createdBy: 'human' });
  const put = (text: string, name = 'note.txt') => h.services.files.put(new TextEncoder().encode(text), name);
  const toAttachment = (file: FileRef): Attachment => ({ fileId: file.id, name: file.name, mime: file.mime, size: file.size });
  const attach = (conversationId: string, ...files: FileRef[]) =>
    h.chats.send({ conversationId, body: 'see attached', authorId: 'human', attachments: files.map(toAttachment) });
  const settle = async () => { await blobs.cleanup.idle(); await media.idle(); };
  const gone = (id: string) => !existsSync(blobs.path(id)) && !blobs.get(id) && !media.get(id)
    && !h.db.get('SELECT 1 AS ok FROM media_fts WHERE file_id = ?', [id]);
  const kept = (id: string) => existsSync(blobs.path(id)) && Boolean(blobs.get(id)) && Boolean(media.get(id));
  const age = () => h.clock.advance(61_000);
  return { h, temp, log, timers, dir, blobs, media, chat, other, put, toAttachment, attach, settle, gone, kept, age };
}

test('a deleted message frees its file once nothing uses it; no timer stays armed', async () => {
  const s = setup();
  try {
    const file = await s.put('secret recording');
    const message = s.attach(s.chat.id, file);
    s.age();
    s.h.chats.removeMessage(message.id, 'human');
    assert.ok(s.kept(file.id), 'nothing is removed synchronously');
    await s.settle();
    assert.ok(s.gone(file.id), 'blob, files row, media row and its search entry are gone');
    assert.equal(s.blobs.cleanup.queued(), 0);
    assert.equal(s.timers.armed.length, 0);
    assert.equal(s.blobs.cleanup.armed(), false);
  } finally { s.temp.cleanup(); }
});

test('a young file waits for the grace and the single timer then reclaims it', async () => {
  const s = setup();
  try {
    const file = await s.put('sent by mistake');
    const message = s.attach(s.chat.id, file);
    s.h.clock.advance(20_000);
    s.h.chats.removeMessage(message.id, 'human');
    await s.settle();
    assert.ok(s.kept(file.id), 'younger than 60 s: kept for now');
    assert.equal(s.blobs.cleanup.queued(), 1);
    assert.deepEqual(s.timers.armed.map((timer) => timer.ms), [40_000], 'one timer, due when the file turns 60 s old');
    s.h.clock.advance(40_000);
    s.timers.fire();
    await s.settle();
    assert.ok(s.gone(file.id));
    assert.equal(s.timers.armed.length, 0, 'no timer left for an empty queue');
  } finally { s.temp.cleanup(); }
});

test('the same bytes stored again count as young (the files row keeps its first time)', async () => {
  const s = setup();
  try {
    const file = await s.put('photo bytes');
    const message = s.attach(s.chat.id, file);
    s.age();
    await s.put('photo bytes', 'again.txt'); // e.g. attached again in another composer
    s.h.chats.removeMessage(message.id, 'human');
    await s.settle();
    assert.ok(s.kept(file.id));
    assert.deepEqual(s.timers.armed.map((timer) => timer.ms), [60_000]);
  } finally { s.temp.cleanup(); }
});

test('a file still used elsewhere stays; a row of a deleted chat moves to the chat that still uses it', async () => {
  const s = setup();
  try {
    const file = await s.put('shared chart');
    s.attach(s.chat.id, file);
    const second = s.attach(s.other.id, file);
    assert.equal(s.media.get(file.id)!.conversationId, s.chat.id, 'the first chat owns the row');
    s.age();
    s.h.chats.remove(s.chat.id);
    await s.settle();
    assert.ok(s.kept(file.id));
    assert.equal(s.media.get(file.id)!.conversationId, s.other.id, 're-linked to the chat that still shows it');
    assert.equal(s.blobs.cleanup.queued(), 0);
    assert.equal(s.timers.armed.length, 0);

    s.h.chats.removeMessage(second.id, 'human');
    await s.settle();
    assert.ok(s.gone(file.id), 'the last use went: reclaimed');
  } finally { s.temp.cleanup(); }
});

test('deleting a chat queues its attachments, block files, draft uploads and picture', async () => {
  const s = setup();
  try {
    const attached = await s.put('attached');
    const shown = await s.put('shown in a block', 'chart.png');
    const drafted = await s.put('in the draft');
    const picture = await s.put('chat picture', 'pic.png');
    s.attach(s.chat.id, attached);
    s.h.chats.send({ conversationId: s.chat.id, authorId: 'ag_ada', body: `Here\n${F}ui\n{"type":"media","fileId":"${shown.id}","kind":"image"}\n${F}` });
    s.h.chats.saveDraft(s.chat.id, 'later', [s.toAttachment(drafted)]);
    s.h.chats.update(s.chat.id, { settings: { image: picture.id } }, 'human');
    assert.equal(fileUses(s.h.db, shown.id).messages.length, 1, 'a block names the file (full-text index)');
    assert.deepEqual(fileUses(s.h.db, drafted.id).other, ['draft']);
    assert.deepEqual(fileUses(s.h.db, picture.id).other, ['chat']);
    s.age();
    s.h.chats.remove(s.chat.id);
    await s.settle();
    for (const file of [attached, shown, drafted, picture]) assert.ok(s.gone(file.id), file.name);
  } finally { s.temp.cleanup(); }
});

test('a draft change never reclaims: the send that arrives after the batch still finds its upload', async () => {
  const s = setup();
  try {
    const dropped = await s.put('wrong file');
    const sent = await s.put('a recording typed about for a minute');
    s.h.chats.saveDraft(s.chat.id, 'long text', [s.toAttachment(dropped), s.toAttachment(sent)]);
    s.age();
    s.h.chats.saveDraft(s.chat.id, 'long text', [s.toAttachment(sent)]); // taken out of the composer
    s.h.chats.saveDraft(s.chat.id, '', []); // Send: Composer.clearDraft persists before messages.send
    await new Promise((resolve) => setImmediate(resolve)); // the batch would run here
    await s.settle();
    assert.equal(s.blobs.cleanup.queued(), 0, 'nothing was queued');
    assert.equal(s.timers.armed.length, 0);
    assert.ok(s.blobs.get(sent.id), 'messages.send still finds the upload (files uploaded with files.upload)');
    const message = s.attach(s.chat.id, sent);
    assert.ok(s.kept(sent.id), 'the sent message uses it');
    assert.ok(s.kept(dropped.id), 'an upload taken out of the composer stays in the media library');

    s.h.chats.removeMessage(message.id, 'human');
    await s.settle();
    assert.ok(s.gone(sent.id), 'deleting the message frees it');
  } finally { s.temp.cleanup(); }
});

test('a text that only links to a file keeps it from the clean-up (a mention, not a message use)', async () => {
  const s = setup();
  try {
    const file = await s.put('linked report data');
    const message = s.attach(s.chat.id, file);
    s.h.chats.send({ conversationId: s.other.id, authorId: 'human', body: `Report: see file ${file.id} for details` });
    const uses = fileUses(s.h.db, file.id);
    assert.deepEqual(uses.messages.map((m) => m.id), [message.id], 'only the attaching message uses it');
    assert.equal(uses.mentions, 1);
    s.age();
    s.h.chats.removeMessage(message.id, 'human');
    await s.settle();
    assert.ok(s.kept(file.id), 'the link keeps it');
    assert.deepEqual(firstUse(s.h.db, file.id), { kind: 'message', conversationId: s.other.id });
  } finally { s.temp.cleanup(); }
});

test('a replaced chat picture is reclaimed; a blob a crash left without its row is removed', async () => {
  const s = setup();
  try {
    const first = await s.put('first picture', 'a.png');
    const second = await s.put('second picture', 'b.png');
    s.h.chats.update(s.chat.id, { settings: { image: first.id } }, 'human');
    s.age();
    s.h.chats.update(s.chat.id, { settings: { image: second.id } }, 'human');
    await s.settle();
    assert.ok(s.gone(first.id));
    assert.ok(s.kept(second.id), 'the current picture is a use');

    const orphan = 'c'.repeat(64);
    mkdirSync(path.dirname(s.blobs.path(orphan)), { recursive: true });
    writeFileSync(s.blobs.path(orphan), 'left behind');
    s.blobs.reclaim([orphan]);
    await s.settle();
    assert.ok(!existsSync(s.blobs.path(orphan)));
    assert.equal(s.blobs.cleanup.queued(), 0);
  } finally { s.temp.cleanup(); }
});

test('every other kind of use keeps a file; history and inactive rows do not', async () => {
  const s = setup();
  try {
    const { db } = s.h;
    const ids: Record<string, string> = {};
    for (const kind of ['task', 'knowledge', 'avatar', 'settings', 'feedback', 'schedule', 'app', 'paused', 'queue']) {
      ids[kind] = (await s.put(`file for ${kind}`)).id;
    }
    db.run(`INSERT INTO tasks (id, conversation_id, title, created_by, created_at, updated_at, result) VALUES ('tk_1', ?, 'Record', 'human', 0, 0, ?)`,
      [s.other.id, JSON.stringify({ summary: 'done', evidence: [{ kind: 'file', label: 'a', ref: ids.task }] })]);
    db.run(`INSERT INTO knowledge (id, scope, kind, title, body, source, recorded_at, created_by) VALUES ('kn_1', 'global', 'fact', 't', 'b', ?, 0, 'human')`,
      [JSON.stringify({ kind: 'file', ref: ids.knowledge, trusted: true })]);
    db.run(`INSERT INTO agents (id, name, avatar, created_by, created_at, updated_at, archived_at) VALUES ('ag_old', 'Old', ?, 'human', 0, 0, 5)`,
      [JSON.stringify({ kind: 'image', value: ids.avatar })]);
    const settingsFile = path.join(s.temp.dir, 'settings.json'); // <data>/settings.json beside <data>/blobs
    writeFileSync(settingsFile, JSON.stringify({ profile: { avatarFileId: ids.settings } }));
    db.run(`INSERT INTO feedback (id, kind, text, author, screenshot_file_id, status, created_at) VALUES ('fb_1', 'bug', 't', 'human', ?, 'draft', 0)`, [ids.feedback]);
    const schedule = `INSERT INTO schedules (id, owner_id, kind, title, spec, payload, active, created_at) VALUES (?, 'human', 'message', 't', '{}', ?, ?, 0)`;
    db.run(schedule, ['sc_1', JSON.stringify({ attachments: [{ fileId: ids.schedule }] }), 1]);
    db.run(schedule, ['sc_2', JSON.stringify({ attachments: [{ fileId: ids.paused }] }), 0]);
    db.run(`INSERT INTO kv (ns, key, value, updated_at) VALUES ('blocks.state', 'msg_1:0', ?, 0)`, [JSON.stringify({ recording: ids.app })]);

    for (const kind of ['task', 'knowledge', 'avatar', 'settings', 'feedback', 'schedule', 'app']) {
      assert.deepEqual(fileUses(db, ids[kind], settingsFile).other, [kind], kind);
    }
    assert.equal(firstUse(db, ids.settings), undefined, 'without the settings file nothing names it');
    assert.deepEqual(firstUse(db, ids.task), { kind: 'task', conversationId: s.other.id });
    for (const kind of ['paused', 'queue']) assert.equal(firstUse(db, ids[kind]), undefined, kind);

    s.age();
    s.blobs.reclaim(Object.values(ids));
    assert.equal(firstUse(db, ids.queue), undefined, 'the clean-up queue itself is no use');
    await s.settle();
    for (const kind of ['task', 'knowledge', 'avatar', 'settings', 'feedback', 'schedule', 'app']) assert.ok(s.kept(ids[kind]), kind);
    for (const kind of ['paused', 'queue']) assert.ok(s.gone(ids[kind]), kind);
    assert.equal(s.blobs.cleanup.queued(), 0);
    assert.equal(s.timers.armed.length, 0);
  } finally { s.temp.cleanup(); }
});

test('a described library item of no chat stays (kept on purpose)', async () => {
  const s = setup();
  try {
    const logo = await s.put('logo bytes', 'logo.png');
    s.media.describe(logo.id, { description: 'Company logo' }, 'human');
    const plain = await s.put('export bytes', 'export.json');
    s.age();
    s.blobs.reclaim([logo.id, plain.id]);
    await s.settle();
    assert.ok(s.kept(logo.id));
    assert.ok(s.gone(plain.id));
  } finally { s.temp.cleanup(); }
});

test('a file an agent works with backs off; it goes once the run ended; dispose clears the timer', async () => {
  const s = setup();
  try {
    const { db } = s.h;
    const file = await s.put('being transcribed');
    db.run(`INSERT INTO runs (id, agent_id, trigger, status) VALUES ('run_1', 'ag_ada', 'message', 'running')`);
    db.run(`INSERT INTO run_items (id, run_id, seq, kind, name, data, created_at) VALUES ('ri_1', 'run_1', 1, 'tool_call', 'media.transcribe', ?, 0)`,
      [JSON.stringify({ fileId: file.id })]);
    assert.ok(isBusy(db, file.id));
    assert.equal(fileUses(db, file.id).busy, true);
    s.age();
    s.blobs.reclaim([file.id]);
    await s.settle();
    assert.ok(s.kept(file.id));
    assert.deepEqual(s.timers.armed.map((timer) => timer.ms), [60_000], 'first back-off: 1 min');

    s.h.clock.advance(60_000);
    s.timers.fire();
    await s.settle();
    assert.deepEqual(s.timers.armed.map((timer) => timer.ms), [120_000], 'still running: 2 min');

    db.run(`UPDATE runs SET status = 'done' WHERE id = 'run_1'`);
    assert.equal(isBusy(db, file.id), false, 'a finished run is history');
    s.h.clock.advance(120_000);
    s.timers.fire();
    await s.settle();
    assert.ok(s.gone(file.id));
    assert.equal(s.timers.armed.length, 0);

    const later = await s.put('another');
    s.blobs.reclaim([later.id]);
    await s.settle();
    assert.equal(s.timers.armed.length, 1, 'young: armed');
    s.blobs.cleanup.dispose();
    assert.equal(s.timers.armed.length, 0, 'dispose clears it');
    assert.equal(s.blobs.cleanup.armed(), false);
  } finally { s.temp.cleanup(); }
});

test('a pending wake that names the file (answer paths) marks it busy', async () => {
  const s = setup();
  try {
    const file = await s.put('answer recording');
    s.h.wakes.wake({ agentId: 'ag_ada', reason: 'answer', conversationId: s.chat.id, note: `[ui-answer]\npath: ${s.blobs.path(file.id)} (a.webm, audio/webm)` });
    assert.equal(isBusy(s.h.db, file.id), true);
  } finally { s.temp.cleanup(); }
});

test('start-up reconcile: the interrupted queue, rows of chats deleted before MM6 and old temp parts', async () => {
  const s = setup();
  try {
    const queued = await s.put('queued before quit');
    const message = s.attach(s.chat.id, queued);
    s.h.chats.removeMessage(message.id, 'human'); // young: stays queued
    await s.settle();
    s.blobs.cleanup.dispose(); // the app quits

    const legacy = await s.put('chat deleted before MM6');
    s.attach(s.other.id, legacy);
    s.h.db.run('DELETE FROM messages_fts WHERE conversation_id = ?', [s.other.id]);
    s.h.db.run('DELETE FROM conversations WHERE id = ?', [s.other.id]); // no clean-up ran for it
    const tmp = path.join(s.dir, 'tmp');
    mkdirSync(tmp, { recursive: true });
    const stale = path.join(tmp, 'stale.part');
    const fresh = path.join(tmp, 'fresh.part');
    writeFileSync(stale, 'x');
    writeFileSync(fresh, 'y');
    utimesSync(stale, new Date(s.h.clock.now() - 2 * 3600_000), new Date(s.h.clock.now() - 2 * 3600_000));
    utimesSync(fresh, new Date(s.h.clock.now() - 60_000), new Date(s.h.clock.now() - 60_000));

    // Next start: a new store on the same data.
    const timers = new FakeTimers();
    const next = new Blobs({ db: s.h.db, blobs: s.dir, clock: s.h.clock, log: s.log, timers });
    s.h.services.files = next;
    s.age();
    s.h.chats.reconcileStreaming();
    await next.cleanup.idle();
    assert.ok(s.gone(queued.id), 'the queue a quit interrupted is finished');
    assert.ok(s.gone(legacy.id), 'files of a chat deleted earlier are reclaimed');
    assert.ok(!existsSync(stale), 'an old temp part is removed');
    assert.ok(existsSync(fresh), 'a recent one may still be written');
    assert.equal(next.cleanup.queued(), 0);
    assert.equal(timers.armed.length, 0);
  } finally { s.temp.cleanup(); }
});

test('Blobs.remove refuses while the same bytes are stored; a put waits for a running removal', async () => {
  const s = setup();
  try {
    const bytes = new TextEncoder().encode('race');
    const file = await s.h.services.files.put(bytes, 'a.txt');
    const storing = s.blobs.put(bytes, 'b.txt');
    assert.equal(await s.blobs.remove(file.id), false, 'a put of these bytes is running');
    await storing;
    assert.ok(s.kept(file.id));

    const removing = s.blobs.remove(file.id);
    const again = s.blobs.put(bytes, 'c.txt'); // starts while the blob is being deleted
    assert.equal(await removing, false, 'the removal gives way: the rows stay for the new put');
    const stored = await again;
    assert.equal(stored.id, file.id);
    assert.ok(existsSync(s.blobs.path(file.id)), 'the put waited and wrote the blob again');
    assert.ok(s.blobs.get(file.id), 'its row is intact');

    assert.equal(await s.blobs.remove(file.id), true, 'nothing running: removed');
    assert.ok(s.gone(file.id));
  } finally { s.temp.cleanup(); }
});

test('without a grace override the batch waits 60 s; the end-to-end seam only shortens it', () => {
  assert.equal(graceFromEnv({}), 60_000);
  assert.equal(graceFromEnv({ WORKFORCE_TEST_FILE_GRACE_MS: '1500' }), 1500);
  assert.equal(graceFromEnv({ WORKFORCE_TEST_FILE_GRACE_MS: '' }), 60_000);
  assert.equal(graceFromEnv({ WORKFORCE_TEST_FILE_GRACE_MS: '600000' }), 60_000);
  assert.equal(graceFromEnv({ WORKFORCE_TEST_FILE_GRACE_MS: 'soon' }), 60_000);
  assert.equal(reclaimerOf({ put() {} }), undefined, 'a store without a clean-up (test fakes) is skipped');
});

test('real timers: nothing stays armed once the queue is empty', async () => {
  const h = harness();
  const temp = tempDir();
  try {
    const log = new MemoryLogger();
    const blobs = new Blobs({ db: h.db, blobs: path.join(temp.dir, 'blobs'), clock: h.clock, log, graceMs: 0 });
    h.services.files = blobs;
    h.org.add(agent('ag_ada', 'Ada'));
    const chat = h.chats.create({ title: 'Brand', agentIds: ['ag_ada'], createdBy: 'human' });
    const file = await blobs.put(new TextEncoder().encode('quick'), 'q.txt');
    const message = h.chats.send({ conversationId: chat.id, body: 'x', authorId: 'human', attachments: [{ fileId: file.id, name: 'q.txt', mime: file.mime, size: file.size }] });
    h.chats.removeMessage(message.id, 'human');
    await blobs.cleanup.idle();
    assert.equal(blobs.get(file.id), undefined);
    assert.equal(blobs.cleanup.armed(), false);
    const cleanup = new BlobCleanup({ db: h.db, clock: h.clock, log, remove: async () => true });
    cleanup.reconcile();
    await cleanup.idle();
    assert.equal(cleanup.armed(), false, 'an empty reconcile arms nothing');
  } finally { temp.cleanup(); }
});
