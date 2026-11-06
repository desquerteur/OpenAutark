// An attached Office document is readable text for agents (files/store.ts text() → office.ts):
// the mime comes from the ZIP magic refined by the extension, the text is extracted once and cached.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Blobs } from '../../../src/runtime/files/store.ts';
import { nullLogger } from '../../../src/runtime/system/log.ts';
import { clock, memoryDb, tempDir } from '../store/helpers.ts';
import { docx, pptx, zip } from './office-fixture.ts';
import { sttSetup } from '../media/stt-fixture.ts';

test('an attached .pptx is read as text and cached; a plain zip stays without text', async () => {
  const temp = tempDir();
  try {
    const store = new Blobs({ db: memoryDb(), blobs: path.join(temp.dir, 'blobs'), clock: clock(), log: nullLogger });
    const deck = await store.put(pptx(), 'Launch.pptx');
    assert.equal(deck.mime, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    const text = await store.text(deck.id);
    assert.match(text ?? '', /^# Slide 1: Launch review/);
    assert.equal(await store.text(deck.id), text, 'cached');
    const archive = await store.put(zip([{ name: 'notes.txt', data: 'plain' }]), 'bundle.zip'); // other bytes (same bytes dedupe to one file)
    assert.equal(archive.mime, 'application/zip');
    assert.equal(await store.text(archive.id), undefined);
  } finally {
    temp.cleanup();
  }
});

test("a chat turn's input carries the text of an attached .docx (extracted ahead of the turn, like a PDF)", async () => {
  const t = sttSetup({ stt: 'missing' });
  try {
    const file = await t.put(new Uint8Array(docx()), 'Plan.docx');
    assert.equal(file.mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const attachment = { fileId: file.id, name: file.name, mime: file.mime, size: file.size };
    t.h.chats.send({ conversationId: t.chat.id, body: 'summarise the plan', authorId: 'human', attachments: [attachment] });
    await t.context.prepare({ agentId: 'ag_ada', conversationId: t.chat.id, sinceSeq: 0 });
    const text = t.context.delta({ agent: t.h.org.require('ag_ada'), conversationId: t.chat.id, sinceSeq: 0, full: false }).text;
    assert.match(text, /\[Attached file: Plan\.docx\]/);
    assert.match(text, /# Quarterly plan/, text);
    assert.match(text, /\| Mara \| 2026-11-01 \|/);
  } finally { t.temp.cleanup(); }
});
