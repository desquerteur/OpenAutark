// MediaService (src/runtime/media/service.ts + library.ts + repo.ts) on a real blob store:
// one row per stored file (idempotent), background probes that fill facts and emit once,
// message attachments linking files to their first chat, search (German folding, all words
// then any word, substring fallback) with filters, and human descriptions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topicOf } from '../../../src/shared/api/events.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { MediaInfo } from '../../../src/shared/model/media.ts';
import { fakePdf, jpegLateSof, png, str, wav, webmRecording } from './fixtures.ts';
import { mediaSetup } from './setup.ts';

test('every stored file gets one row (kind, size, header size); storing it again changes nothing', async () => {
  const { temp, media, put, upserts } = mediaSetup();
  try {
    const file = await put(png(640, 480), 'Logo.png');
    const row = media.get(file.id)!;
    assert.equal(row.kind, 'image');
    assert.equal(row.mime, 'image/png');
    assert.equal(row.name, 'Logo.png');
    assert.equal(row.size, file.size);
    assert.deepEqual([row.width, row.height], [640, 480]);
    assert.equal(row.conversationId, undefined);
    assert.equal(upserts().length, 1);

    await put(png(640, 480), 'copy.png'); // same sha256
    await media.idle();
    assert.equal(upserts().length, 1);
    assert.equal(media.get(file.id)!.name, 'Logo.png');
    assert.equal(media.list().length, 1);
  } finally { temp.cleanup(); }
});

test('background probes fill duration, late JPEG size, audio-only kind and PDF pages, one event each', async () => {
  const counted: number[] = [];
  const { temp, media, put, upserts } = mediaSetup({ pdfPages: async (bytes) => { counted.push(bytes.length); return 4; } });
  try {
    const voice = await put(wav(2000), 'voice.wav');
    assert.equal(media.get(voice.id)!.durationMs, undefined); // the upload never waits for the probe
    const photo = await put(jpegLateSof(4000, 3000), 'photo.jpg');
    const note = await put(webmRecording([{ timecode: 0, blocks: [0, 20] }, { timecode: 1000, blocks: [0, 500] }]), 'note.webm', 'audio/webm');
    const doc = await put(fakePdf(), 'brief.pdf');
    await media.idle();

    assert.equal(media.get(voice.id)!.durationMs, 2000);
    assert.deepEqual([media.get(photo.id)!.width, media.get(photo.id)!.height], [4000, 3000]);
    assert.equal(media.get(note.id)!.kind, 'audio');
    assert.equal(media.get(note.id)!.mime, 'video/webm');
    assert.equal(media.get(note.id)!.durationMs, 1500);
    assert.equal(media.get(doc.id)!.pages, 4);
    assert.deepEqual(counted, [fakePdf().length]);
    // insert + probe result per file
    for (const id of [voice.id, photo.id, note.id, doc.id]) assert.equal(upserts().filter((info) => info.fileId === id).length, 2, id);
    assert.equal(upserts().at(-1)!.fileId, doc.id);
  } finally { temp.cleanup(); }
});

test('message attachments link a file to the first chat it appears in (also files stored before the library)', async () => {
  const { h, temp, media, chat, other, put, attach, upserts } = mediaSetup();
  try {
    const file = await put(png(10, 10), 'mock.png');
    attach(chat.id, file);
    const linked = media.get(file.id)!;
    assert.equal(linked.conversationId, chat.id);
    const event = upserts().at(-1)!;
    assert.equal(event.conversationId, chat.id);
    assert.equal(topicOf('media.upserted', event), `chat:${chat.id}`);

    attach(other.id, file); // forwarded later: the first chat keeps it
    assert.equal(media.get(file.id)!.conversationId, chat.id);
    assert.equal(upserts().length, 2);

    // A files row without a media row (e.g. stored before migration 2) is recorded on first use.
    const legacy = 'd'.repeat(64);
    h.db.run(`INSERT INTO files (id, name, mime, size, created_at, width, height) VALUES (?, 'old.png', 'image/png', 99, 1, 3, 2)`, [legacy]);
    attach(other.id, { id: legacy, name: 'old.png', mime: 'image/png', size: 99, createdAt: 1 });
    assert.deepEqual([media.get(legacy)!.conversationId, media.get(legacy)!.width], [other.id, 3]);
    await media.idle();
  } finally { temp.cleanup(); }
});

test('list: chat and kind filters, folded search over name/description/tags, all words first, then any, then substring', async () => {
  const { temp, media, chat, put, attach } = mediaSetup();
  try {
    const logo = await put(png(10, 10), 'logo-final.png');
    const voice = await put(wav(1000), 'Sprachnotiz.wav');
    const sheet = await put(str('a,b\n1,2\n'), 'numbers.csv');
    attach(chat.id, logo, voice);
    media.describe(logo.id, { description: 'Logo für Müller, blau auf weiß', tags: ['Brand'] }, 'human');
    await media.idle();

    const ids = (list: MediaInfo[]) => list.map((info) => info.fileId).sort();
    assert.deepEqual(ids(media.list({ conversationId: chat.id })), [logo.id, voice.id].sort());
    assert.deepEqual(ids(media.list({ kind: 'audio' })), [voice.id]);
    assert.deepEqual(ids(media.list({ kind: 'document' })), [sheet.id]);
    assert.deepEqual(ids(media.list({ text: 'mueller' })), [logo.id]); // ü folded at index and query time
    assert.deepEqual(ids(media.list({ text: 'Müller' })), [logo.id]);
    assert.deepEqual(ids(media.list({ text: 'blau brand' })), [logo.id]); // words from description + tags
    assert.deepEqual(ids(media.list({ text: 'logo sprachnotiz' })), [logo.id, voice.id].sort()); // no row has both → any word
    assert.deepEqual(ids(media.list({ text: 'sprach' })), [voice.id]); // prefix
    assert.deepEqual(ids(media.list({ text: 's.c' })), [sheet.id]); // no token → substring ("numbers.csv")
    assert.deepEqual(ids(media.list({ text: 'q.z' })), []);
    assert.deepEqual(ids(media.list({ text: 'v' })), [sheet.id, voice.id].sort()); // single letter → substring
    assert.deepEqual(ids(media.list({ text: 'logo', kind: 'audio' })), []);
    assert.equal(media.list({ limit: 1 }).length, 1);
  } finally { temp.cleanup(); }
});

test('describe: trims, dedupes tags, ignores unchanged patches, clears the author with nothing left; unknown file is not_found', async () => {
  const { temp, media, put, upserts } = mediaSetup();
  try {
    const file = await put(png(10, 10), 'cover.png');
    const described = media.describe(file.id, { description: '  Cover for episode 12\n\n\n\nwith title  ', tags: [' #video', 'Video', 'cover  art', ''] }, 'human');
    assert.equal(described.description, 'Cover for episode 12\n\nwith title');
    assert.deepEqual(described.tags, ['video', 'cover art']);
    assert.equal(described.describedBy, 'human');
    assert.equal(typeof described.describedAt, 'number');
    const events = upserts().length;

    assert.deepEqual(media.describe(file.id, { tags: ['video', 'cover art'] }, 'human'), described);
    assert.deepEqual(media.describe(file.id, {}, 'human'), described);
    assert.equal(upserts().length, events);

    const tagsOnly = media.describe(file.id, { description: '' }, 'human');
    assert.equal(tagsOnly.description, undefined);
    assert.equal(tagsOnly.describedBy, 'human');
    const cleared = media.describe(file.id, { tags: [] }, 'human');
    assert.deepEqual([cleared.description, cleared.tags, cleared.describedBy, cleared.describedAt], [undefined, undefined, undefined, undefined]);
    assert.deepEqual(media.list({ text: 'episode' }), []); // the FTS mirror follows the row

    assert.throws(() => media.describe('e'.repeat(64), { description: 'x' }, 'human'), (error: unknown) => error instanceof WorkforceError && error.code === 'not_found');
  } finally { temp.cleanup(); }
});

test('onFileStored never throws: a file without a files row is logged and skipped', () => {
  const { h, temp, media } = mediaSetup();
  try {
    const warnings: unknown[] = [];
    h.services.log = { ...h.services.log, warn: (message: string) => { warnings.push(message); } };
    assert.doesNotThrow(() => media.onFileStored({ id: 'f'.repeat(64), name: 'x.png', mime: 'image/png', size: 1, createdAt: 1 }));
    assert.equal(media.get('f'.repeat(64)), undefined);
    assert.deepEqual(warnings, ['media row not recorded']);
  } finally { temp.cleanup(); }
});
