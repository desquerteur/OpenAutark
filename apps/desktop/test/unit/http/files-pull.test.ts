// B-075: GET /files/<sha256> of a file whose row came from another of the person's PCs and whose bytes are not here
// yet – the server fetches them from a linked CEO PC (devices/sync/blobs.ts needBlob) before it answers; a file no
// linked PC has stays a 404. Real HttpServer on loopback, the other PC a fake mesh call serving pieces of its blob.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DevicesRepo, type DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { readPiece } from '../../../src/runtime/devices/sync/file-io.ts';
import { DEVICE_TOKEN, fixture, request } from './fixture.ts';

const record = (id: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({
  id, name: id, kind: 'pc', role: 'home', fingerprint: `fp_${id}`, addresses: [], caps: {}, status: 'online', self: false, ...extra,
});

test('a stored file whose bytes are on another PC is fetched from there, then served; one nobody has stays missing', async () => {
  const f = fixture();
  try {
    const bytes = Buffer.from('a voice note recorded on the laptop');
    const id = createHash('sha256').update(bytes).digest('hex');
    const nobody = createHash('sha256').update('nobody has this').digest('hex');
    const blobs = path.join(f.root, 'blobs');
    const there = path.join(f.root, 'laptop-blob.bin');
    writeFileSync(there, bytes);
    const at = (fileId: string) => path.join(blobs, fileId.slice(0, 2), fileId.slice(2, 4), fileId);
    const calls: unknown[] = [];
    const repo = new DevicesRepo(f.services.db);
    repo.upsert(record('dev_self', { self: true }));
    repo.upsert(record('dev_laptop', { joinedAs: 'ceo' }));
    Object.assign(f.services, {
      paths: { blobs },
      files: {
        get: (fileId: string) => ([id, nobody].includes(fileId) ? { id: fileId, name: 'note.webm', mime: 'audio/webm', size: bytes.length, createdAt: 0 } : undefined),
        path: at,
      },
      devices: {
        online: (peer: string) => peer === 'dev_laptop',
        call: async (peer: string, method: string, params: { op: string; id: string; offset: number }) => {
          calls.push({ peer, method, op: params.op, id: params.id });
          if (params.id !== id) throw new Error('not here either');
          return readPiece(there, params.offset);
        },
      },
    });
    mkdirSync(blobs, { recursive: true });
    const { port } = await f.server.listen();

    const served = await request(port, { path: `/files/${id}`, headers: { authorization: `Bearer ${DEVICE_TOKEN}` } });
    assert.equal(served.status, 200);
    assert.equal(served.text, bytes.toString());
    assert.ok(existsSync(at(id)), 'the bytes are kept here');
    assert.deepEqual(calls, [{ peer: 'dev_laptop', method: 'sync.file', op: 'blob', id }]);
    assert.equal((await request(port, { path: `/files/${id}?token=${DEVICE_TOKEN}` })).status, 200);
    assert.equal(calls.length, 1, 'here now: no second fetch');

    const missing = await request(port, { path: `/files/${nobody}?token=${DEVICE_TOKEN}` });
    assert.equal(missing.status, 404);
    assert.match(missing.text, /The stored file is missing\./);
    assert.equal(existsSync(at(nobody)), false);
  } finally {
    await f.close();
  }
});
