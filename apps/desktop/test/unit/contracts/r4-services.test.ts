// R4 contract invariants of the pinned services (MediaService, Portability, Bridges,
// applyPendingRestore) that must keep holding once the packages implement them: the pinned
// constructors and methods exist, an upload never fails because of the media hook, an empty
// data dir has no staged restore, and bridges make no requests while none is stored.
// Owns: shape/invariant checks only (behaviour is tested by the media, portability and
// bridges packages).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { MediaService } from '../../../src/runtime/media/service.ts';
import { Portability } from '../../../src/runtime/portability/service.ts';
import { applyPendingRestore } from '../../../src/runtime/portability/restore.ts';
import { Bridges } from '../../../src/runtime/bridges/service.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { clock, memoryDb, recordingBus, tempDir } from '../store/helpers.ts';

const FILE = 'b'.repeat(64);

function services(): RuntimeServices {
  const db = memoryDb();
  db.run(`INSERT INTO files (id, name, mime, size, created_at) VALUES (?, 'a.png', 'image/png', 3, 1)`, [FILE]);
  return { db, bus: recordingBus().bus, clock: clock(), log: new MemoryLogger() } as unknown as RuntimeServices;
}

const methods = (value: object, names: string[]) => {
  for (const name of names) assert.equal(typeof (value as Record<string, unknown>)[name], 'function', name);
};

test('MediaService: pinned API, onFileStored never throws, unknown files are not found', () => {
  const s = services();
  const media = new MediaService({ services: () => s });
  methods(media, ['onFileStored', 'list', 'describe', 'get', 'tools']);
  const file = { id: FILE, name: 'a.png', mime: 'image/png', size: 3, createdAt: 1 };
  assert.doesNotThrow(() => media.onFileStored(file));
  assert.doesNotThrow(() => media.onFileStored(file, { conversationId: 'ch_1' }));
  assert.equal(media.get('c'.repeat(64)), undefined);
  assert.ok(Array.isArray(media.tools()));
});

test('Portability: pinned API; an empty data dir has no staged restore', () => {
  const s = services();
  const portability = new Portability({ services: () => s });
  methods(portability, ['exportAgent', 'backup', 'restore']);
  const temp = tempDir();
  try {
    assert.equal(applyPendingRestore(temp.dir, new MemoryLogger()), false);
    assert.deepEqual(readdirSync(temp.dir), []); // nothing created or moved
  } finally { temp.cleanup(); }
});

test('Bridges: pinned API; start/stop without stored bridges make no requests', () => {
  const s = services();
  let requests = 0;
  const bridges = new Bridges({ services: () => s, fetch: (async () => { requests++; return new Response('{}'); }) as typeof fetch });
  methods(bridges, ['start', 'stop', 'list', 'connectTelegram', 'disconnect', 'tools']);
  assert.doesNotThrow(() => bridges.start());
  assert.doesNotThrow(() => bridges.stop());
  assert.equal(requests, 0);
  assert.ok(Array.isArray(bridges.tools()));
});
