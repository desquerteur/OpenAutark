import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Blobs } from '../../../src/runtime/files/store.ts';
import { detectMime, imageSize } from '../../../src/runtime/files/mime.ts';
import { extractPdfText } from '../../../src/runtime/files/pdf.ts';
import { nullLogger } from '../../../src/runtime/system/log.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { clock, memoryDb, tempDir } from '../store/helpers.ts';

/** 1×1 transparent PNG with a 3×2 IHDR (dimensions are what we parse). */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

/** Minimal valid one-page PDF with real xref offsets. */
function pdf(text: string): Uint8Array {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

function setup(pdfText?: (bytes: Uint8Array) => Promise<string>) {
  const temp = tempDir();
  const db = memoryDb();
  const store = new Blobs({ db, blobs: path.join(temp.dir, 'blobs'), clock: clock(), log: nullLogger, pdfText });
  return { store, db, ...temp };
}

test('put: content-addressed path, dedupe, metadata row', async () => {
  const { store, dir, cleanup } = setup();
  try {
    const data = new TextEncoder().encode('hello world');
    const sha = createHash('sha256').update(data).digest('hex');
    const ref = await store.put(data, 'notes.md');
    assert.equal(ref.id, sha);
    assert.equal(ref.mime, 'text/markdown');
    assert.equal(ref.size, 11);
    assert.equal(store.path(sha), path.join(dir, 'blobs', sha.slice(0, 2), sha.slice(2, 4), sha));
    assert.ok(existsSync(store.path(sha)));
    const again = await store.put(data, 'copy.txt');
    assert.equal(again.name, 'notes.md', 'same content keeps the first row');
    assert.deepEqual(new TextDecoder().decode(await store.read(sha)), 'hello world');
    assert.deepEqual(readdirSync(path.join(dir, 'blobs', 'tmp')), [], 'no temp leftovers');
    await assert.rejects(store.put(new Uint8Array(0), 'empty'), (error: unknown) => error instanceof WorkforceError);
    assert.throws(() => store.path('../etc/passwd'), WorkforceError);
    assert.equal(store.get('nope'), undefined);
  } finally { cleanup(); }
});

test('mime by magic bytes, not by name; image dimensions parsed', async () => {
  const { store, cleanup } = setup();
  try {
    const image = await store.put(png(640, 480), 'photo.pdf');
    assert.equal(image.mime, 'image/png');
    assert.equal(image.width, 640);
    assert.equal(image.height, 480);
    const binary = await store.put(new Uint8Array([0, 1, 2, 3, 255]), 'x.txt', 'audio/x-custom');
    assert.equal(binary.mime, 'audio/x-custom');
    assert.equal(detectMime(new Uint8Array([0, 159, 146, 150]), 'a.bin'), 'application/octet-stream');
    assert.equal(detectMime(new TextEncoder().encode('%PDF-1.7'), 'a.txt'), 'application/pdf');
    assert.equal(detectMime(new TextEncoder().encode('GIF89a......'), ''), 'image/gif');
    assert.equal(detectMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), ''), 'image/jpeg');
    assert.equal(detectMime(new TextEncoder().encode('RIFF....WEBPVP8 '), ''), 'image/webp');
    assert.equal(detectMime(new TextEncoder().encode('....ftypisom'), ''), 'video/mp4');
    assert.equal(detectMime(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 'a.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(detectMime(new TextEncoder().encode('{"a":1}'), 'data.json'), 'application/json');
    const gif = new Uint8Array([...new TextEncoder().encode('GIF89a'), 10, 0, 20, 0]);
    assert.deepEqual(imageSize(gif, 'image/gif'), { width: 10, height: 20 });
    // JPEG: SOI, APP0 (length 4), SOF0 with height 2, width 3
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 0, 0, 0]);
    assert.deepEqual(imageSize(jpeg, 'image/jpeg'), { width: 3, height: 2 });
  } finally { cleanup(); }
});

test('text: text files extracted lazily and cached; binaries have none', async () => {
  const { store, db, cleanup } = setup();
  try {
    const ref = await store.put(new TextEncoder().encode('Line one\nLine two'), 'a.txt');
    assert.equal(db.get<{ t: string | null }>('SELECT text_preview AS t FROM files WHERE id = ?', [ref.id])!.t, null, 'not extracted on put');
    assert.equal(await store.text(ref.id), 'Line one\nLine two');
    assert.equal(await store.text(ref.id, 4), 'Line');
    assert.equal(store.get(ref.id)?.textPreview, 'Line one\nLine two');
    const image = await store.put(png(1, 1), 'p.png');
    assert.equal(await store.text(image.id), undefined);
    assert.equal(await store.text('f'.repeat(64)), undefined);
  } finally { cleanup(); }
});

test('pdf text: extractor runs once (even concurrently), result cached, errors not cached', async () => {
  let calls = 0;
  let fail = true;
  const { store, cleanup } = setup(async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (fail) throw new WorkforceError('bad_request', 'Unlock this PDF before attaching it.');
    return 'Invoice 42';
  });
  try {
    const ref = await store.put(pdf('x'), 'invoice.pdf');
    assert.equal(ref.mime, 'application/pdf');
    assert.equal(calls, 0, 'lazy');
    await assert.rejects(store.text(ref.id), /Unlock/);
    fail = false;
    const [a, b] = await Promise.all([store.text(ref.id), store.text(ref.id)]);
    assert.equal(a, 'Invoice 42');
    assert.equal(b, 'Invoice 42');
    assert.equal(calls, 2);
    assert.equal(await store.text(ref.id), 'Invoice 42');
    assert.equal(calls, 2, 'cached');
  } finally { cleanup(); }
});

test('real pdf.js extraction (with DOMMatrix polyfill)', async () => {
  const text = await extractPdfText(pdf('Hello Workforce'));
  assert.match(text, /Hello Workforce/);
  await assert.rejects(extractPdfText(new TextEncoder().encode('%PDF-1.4 garbage')), (error: unknown) => error instanceof WorkforceError);
});

test('putPath streams a file into the store', async () => {
  const { store, dir, cleanup } = setup();
  try {
    const source = path.join(dir, 'report.csv');
    const content = 'a,b\n'.repeat(100_000);
    writeFileSync(source, content);
    const ref = await store.putPath(source);
    assert.equal(ref.name, 'report.csv');
    assert.equal(ref.mime, 'text/csv');
    assert.equal(ref.size, content.length);
    assert.equal(ref.id, createHash('sha256').update(content).digest('hex'));
    await assert.rejects(store.putPath(path.join(dir, 'missing.txt')), (error: unknown) => error instanceof WorkforceError && error.code === 'not_found');
    await assert.rejects(store.putPath(dir), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');
  } finally { cleanup(); }
});

test('putPath uses the mime hint when sniffing finds nothing (like put)', async () => {
  const { store, dir, cleanup } = setup();
  try {
    const write = (name: string, bytes: number[]) => { const file = path.join(dir, name); writeFileSync(file, Buffer.from(bytes)); return file; };
    const aac = await store.putPath(write('voice note', [0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc]), 'audio/aac');
    assert.equal(aac.mime, 'audio/aac');
    assert.equal((await store.putPath(write('blob', [0x00, 0x9c, 0x01, 0x02]))).mime, 'application/octet-stream', 'no hint');
    assert.equal((await store.putPath(write('shot', [...png(3, 2)]), 'audio/aac')).mime, 'image/png', 'magic bytes win over the hint');
  } finally { cleanup(); }
});

test('B-075: a row whose bytes live on another PC – read and text fetch them first (missing), once; without them the read says so', async () => {
  const temp = tempDir();
  const asked: string[] = [];
  const kept = new Map<string, Buffer>(); // the bytes "on the other PC"
  let store!: Blobs;
  const missing = async (id: string) => {
    asked.push(id);
    const bytes = kept.get(id);
    if (!bytes) return false;
    writeFileSync(store.path(id), bytes);
    return true;
  };
  store = new Blobs({ db: memoryDb(), blobs: path.join(temp.dir, 'blobs'), clock: clock(), log: nullLogger, missing });
  try {
    const note = await store.put(new TextEncoder().encode('Notes from the laptop'), 'notes.txt');
    const photo = await store.put(png(2, 2), 'photo.png');
    for (const ref of [note, photo]) { kept.set(ref.id, Buffer.from(await store.read(ref.id))); rmSync(store.path(ref.id)); } // only the rows stayed here
    assert.deepEqual(asked, [], 'bytes that are here are never fetched');

    assert.equal(await store.text(note.id), 'Notes from the laptop');
    assert.deepEqual([...await store.read(photo.id)], [...png(2, 2)]);
    assert.deepEqual(await store.read(photo.id), new Uint8Array(png(2, 2)), 'here now: no second fetch');
    assert.deepEqual(asked, [note.id, photo.id]);

    kept.delete(photo.id);
    rmSync(store.path(photo.id));
    await assert.rejects(store.read(photo.id), (error: unknown) => error instanceof WorkforceError && error.code === 'not_found' && error.message === 'The stored file is missing.');
    await assert.rejects(store.read('e'.repeat(64)), (error: unknown) => error instanceof WorkforceError && error.message === 'This file does not exist.');
    assert.deepEqual(asked, [note.id, photo.id, photo.id], 'a file without a row is never asked for');
  } finally { temp.cleanup(); }
});
