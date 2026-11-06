// UI uploads: files up to 4 MB go in one files.upload frame, larger ones in ≤ 4 MB
// files.uploadChunk frames (the PWA /ws frame limit is 6 MB), 20 MB per file at most.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FileRef } from '../../../src/shared/model/system.ts';
import { CHUNK_BYTES, INLINE_MAX_BYTES, MAX_FILE_BYTES, toAttachment, uploadBlob, uploadRef } from '../../../src/ui/lib/files.ts';
import type { UploadRpc } from '../../../src/ui/lib/files.ts';

const MB = 1024 * 1024;
const WS_FRAME_LIMIT = 6 * MB;

function ref(name: string, size: number): FileRef {
  return { id: 'a'.repeat(64), name, mime: 'application/octet-stream', size, createdAt: 1 } as FileRef;
}

function fakeRpc() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let received = 0;
  const via = {
    async call(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      const bytes = Buffer.from(String(params.dataBase64), 'base64').length;
      if (method === 'files.upload') return ref(String(params.name), bytes);
      received += bytes;
      return params.final ? { received, file: ref(String(params.name), received) } : { received };
    },
  } as unknown as UploadRpc;
  return { via, calls };
}

function frameSize(params: Record<string, unknown>): number {
  return JSON.stringify({ id: 1, method: 'files.uploadChunk', params }).length;
}

test('uploadRef: small files go inline in one frame', async () => {
  const { via, calls } = fakeRpc();
  const file = await uploadRef(new Blob([new Uint8Array(3 * MB)], { type: 'image/png' }), 'shot.png', via);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'files.upload');
  assert.equal(calls[0].params.mime, 'image/png');
  assert.equal(file.size, 3 * MB);
  assert.ok(frameSize(calls[0].params) < WS_FRAME_LIMIT);
});

test('uploadRef: above 4 MB the file is chunked, every frame below the /ws limit', async () => {
  const { via, calls } = fakeRpc();
  const size = 9 * MB + 123;
  const file = await uploadRef(new Blob([new Uint8Array(size)]), 'video.mp4', via);
  assert.equal(INLINE_MAX_BYTES, 4 * MB);
  assert.deepEqual(calls.map((call) => call.method), ['files.uploadChunk', 'files.uploadChunk', 'files.uploadChunk']);
  assert.deepEqual(calls.map((call) => call.params.index), [0, 1, 2]);
  assert.deepEqual(calls.map((call) => call.params.final), [false, false, true]);
  assert.equal(new Set(calls.map((call) => call.params.uploadId)).size, 1, 'one upload session');
  for (const call of calls) {
    assert.ok(Buffer.from(String(call.params.dataBase64), 'base64').length <= CHUNK_BYTES);
    assert.ok(frameSize(call.params) < WS_FRAME_LIMIT);
  }
  assert.equal(file.size, size);
});

test('uploadRef: exactly 4 MB still goes inline; more than 20 MB is refused before any call', async () => {
  const inline = fakeRpc();
  await uploadRef(new Blob([new Uint8Array(INLINE_MAX_BYTES)]), 'edge.bin', inline.via);
  assert.deepEqual(inline.calls.map((call) => call.method), ['files.upload']);
  assert.ok(frameSize(inline.calls[0].params) < WS_FRAME_LIMIT);

  const big = fakeRpc();
  await assert.rejects(uploadRef(new Blob([new Uint8Array(MAX_FILE_BYTES + 1)]), 'huge.bin', big.via), /larger than 20 MB/);
  assert.equal(big.calls.length, 0);
});

test('uploadBlob: reports progress per chunk and needs the final file', async () => {
  const { via } = fakeRpc();
  const progress: number[] = [];
  await uploadBlob(new Blob([new Uint8Array(CHUNK_BYTES + 1)]), 'take.webm', (ratio) => progress.push(ratio), via);
  assert.deepEqual(progress, [0.5, 1]);

  const broken = { call: async () => ({ received: 1 }) } as unknown as UploadRpc;
  await assert.rejects(uploadBlob(new Blob([new Uint8Array(10)]), 'x', undefined, broken), /did not finish/);
});

test('toAttachment maps a stored file to a message attachment', () => {
  const attachment = toAttachment({ ...ref('a.png', 5), mime: 'image/png', width: 2, height: 3 });
  assert.deepEqual(attachment, { fileId: 'a'.repeat(64), name: 'a.png', mime: 'image/png', size: 5, width: 2, height: 3, durationMs: undefined });
});
