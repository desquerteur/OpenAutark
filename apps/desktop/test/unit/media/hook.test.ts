// The FileStore media hook (src/runtime/media/hook.ts): every successful put/putPath reaches
// the listener with the stored FileRef, results and errors of the store are unchanged, and a
// failing listener never fails an upload.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Blobs } from '../../../src/runtime/files/store.ts';
import { withMediaHook } from '../../../src/runtime/media/hook.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { FileRef } from '../../../src/shared/model/system.ts';
import { clock, memoryDb, tempDir } from '../store/helpers.ts';

function setup(onStored: (file: FileRef) => void) {
  const temp = tempDir();
  const log = new MemoryLogger();
  const blobs = new Blobs({ db: memoryDb(), blobs: path.join(temp.dir, 'blobs'), clock: clock(), log });
  const files = withMediaHook(blobs, onStored, log);
  return { temp, log, blobs, files };
}

test('put and putPath notify the listener with the stored FileRef (also for known content)', async () => {
  const seen: FileRef[] = [];
  const { temp, blobs, files } = setup((file) => seen.push(file));
  try {
    assert.equal(files, blobs); // same object: other members and identity unchanged
    const stored = await files.put(new TextEncoder().encode('hello'), 'note.txt');
    assert.deepEqual(seen, [stored]);
    assert.deepEqual(files.get(stored.id), stored);

    const source = path.join(temp.dir, 'clip.txt');
    writeFileSync(source, 'from disk');
    const fromPath = await files.putPath(source, 'text/plain');
    assert.equal(fromPath.name, 'clip.txt');
    assert.deepEqual(seen.at(-1), fromPath);

    await files.put(new TextEncoder().encode('hello'), 'again.txt'); // same sha256 → same row
    assert.equal(seen.length, 3);
    assert.equal(seen[2].id, stored.id);
  } finally { temp.cleanup(); }
});

test('a failing store call never reaches the listener and keeps its error', async () => {
  const seen: FileRef[] = [];
  const { temp, files } = setup((file) => seen.push(file));
  try {
    await assert.rejects(files.put(new Uint8Array(0), 'empty.txt'), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');
    await assert.rejects(files.putPath(path.join(temp.dir, 'missing.bin')), (error: unknown) => error instanceof WorkforceError && error.code === 'not_found');
    assert.equal(seen.length, 0);
  } finally { temp.cleanup(); }
});

test('a throwing listener is logged and the upload still succeeds', async () => {
  const { temp, log, files } = setup(() => { throw new Error('media down'); });
  try {
    const stored = await files.put(new TextEncoder().encode('still stored'), 'a.txt');
    assert.equal(stored.size, 12);
    const warning = log.entries.find((entry) => entry.message === 'media hook failed');
    assert.equal(warning?.level, 'warn');
    assert.equal(warning?.data?.id, stored.id);
  } finally { temp.cleanup(); }
});
