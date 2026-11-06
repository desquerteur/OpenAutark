// A deleted chat's space leaves <data>/side-tabs.json (src/runtime/root/side-tabs.ts): only that space, the rest as it
// was; no file, or a chat without a space: nothing is written; a broken file stays as it is.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { watchRemovedChats, withoutChatSpace } from '../../../src/runtime/root/side-tabs.ts';

const DOC = { version: 2, spaces: {
  global: { shown: 'day', tabs: [{ id: 'day', panel: 'day' }] },
  'chat:ch_1': { shown: 'web-a', tabs: [{ id: 'web-a', url: 'https://a.example/' }, { id: 'notes:ch_1', panel: 'notes', conversationId: 'ch_1' }] },
  'chat:ch_2': { tabs: [{ id: 'web-b', url: 'https://b.example/' }] },
} };

test('only the deleted chat\'s space goes', () => {
  const next = JSON.parse(withoutChatSpace(JSON.stringify(DOC), 'ch_1')!);
  assert.deepEqual(Object.keys(next.spaces), ['global', 'chat:ch_2']);
  assert.deepEqual(next.spaces.global, DOC.spaces.global);
  assert.equal(next.version, 2);
  assert.equal(withoutChatSpace(JSON.stringify(DOC), 'ch_9'), undefined, 'no space: nothing to do');
});

test('on conversation.removed the file changes; a missing or broken file is left alone', (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'side-tabs-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'side-tabs.json');
  const warnings: string[] = [];
  let removed: (data: { id: string }) => void = () => undefined;
  watchRemovedChats({ dataDir, bus: { on: (_event, listener) => { removed = listener; } }, log: { warn: (message) => warnings.push(message) } });

  removed({ id: 'ch_1' });
  assert.equal(existsSync(file), false, 'no file is made');
  assert.equal(warnings.length, 0);

  writeFileSync(file, JSON.stringify(DOC));
  const before = statSync(file).mtimeMs;
  removed({ id: 'ch_9' });
  assert.equal(statSync(file).mtimeMs, before, 'a chat without a space: not rewritten');
  removed({ id: 'ch_1' });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).spaces), ['global', 'chat:ch_2']);

  writeFileSync(file, '{ half written');
  removed({ id: 'ch_2' });
  assert.equal(readFileSync(file, 'utf8'), '{ half written');
  assert.equal(warnings.length, 1);
});
