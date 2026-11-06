// Composer drafts (ui/chat/composer/draft.ts): a save that went down with the connection is written
// again – the draft as it is then – once rpc reconnects, so an attached dictation take the
// runtime's blob clean-up waits for reaches the drafts table; a save that went through or one the
// runtime refused is not repeated, and a pending change saves the draft on its own.
// Owns: these assertions only. Never: a real runtime (rpc.call and rpc.onOpen are fakes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Attachment } from '../../../src/shared/model/chat.ts';
import { RpcError, rpc } from '../../../src/ui/lib/rpc.ts';

const reconnects: Array<() => void> = [];
(rpc as unknown as { onOpen: unknown }).onOpen = (fn: () => void) => { reconnects.push(fn); return () => undefined; };
const saves: Array<{ conversationId: string; text: string; attachments: Attachment[] }> = [];
let answer: () => Promise<unknown> = async () => ({ ok: true });
(rpc as unknown as { call: unknown }).call = (method: string, params: (typeof saves)[number]) => {
  if (method === 'ui.saveDraft') saves.push(params);
  return answer();
};
const { draftFor, flushDraft, updateDraft } = await import('../../../src/ui/chat/composer/draft.ts');
const { loaded, secretDrafts } = await import('../../../src/ui/lib/store.ts');

test('a draft read by desktop boot before ui.state hydrates its secret references once the snapshot arrives', () => {
  loaded.value = false;
  const early = draftFor('cv_boot_secret');
  assert.deepEqual(early.peek().secrets, []);
  secretDrafts.value = { ...secretDrafts.value, cv_boot_secret: ['sec_test'] };
  loaded.value = true;
  assert.deepEqual(draftFor('cv_boot_secret').peek().secrets, ['sec_test']);
  updateDraft('cv_boot_secret', { secrets: [] });
  flushDraft('cv_boot_secret');
  assert.deepEqual(draftFor('cv_boot_secret').peek().secrets, []);
  saves.length = 0;
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const LOST = () => Promise.reject(new RpcError({ code: 'unavailable', message: 'Connection to the runtime was lost.' }));
const TAKE: Attachment = { fileId: 'a'.repeat(64), name: 'Dictation 2026-10-21 09-30.webm', mime: 'video/webm', size: 7 };

/** Changes the draft and saves it at once (the debounce flushed); the answer arrives before it returns. */
async function save(conversationId: string, patch: Parameters<typeof updateDraft>[1]): Promise<void> {
  updateDraft(conversationId, patch);
  flushDraft(conversationId);
  await tick();
}

async function reconnect(): Promise<void> {
  rpc.status.value = 'open';
  for (const listener of reconnects) listener();
  await tick();
}

test('a save lost with the connection is written again after the reconnect, with the draft as it is then', async () => {
  rpc.status.value = 'closed';
  answer = LOST;
  await save('c1', { text: 'Call Anna', attachments: [TAKE] });
  assert.equal(saves.length, 1);
  draftFor('c1').value = { ...draftFor('c1').value, text: 'Call Anna back' };
  answer = async () => ({ ok: true });
  await reconnect();
  assert.deepEqual(saves.slice(1), [{ conversationId: 'c1', text: 'Call Anna back', attachments: [TAKE] }]);
  await reconnect();
  assert.equal(saves.length, 2, 'a save that went through is not repeated');
});

test('a refused save or an answered failure is not repeated; a pending change saves the draft itself', async () => {
  saves.length = 0;
  rpc.status.value = 'closed';
  answer = () => Promise.reject(new RpcError({ code: 'bad_request', message: 'Invalid parameter "text".' }));
  await save('c2', { text: 'x' });
  rpc.status.value = 'open';
  answer = () => Promise.reject(new RpcError({ code: 'unavailable', message: 'The database is busy.' }));
  await save('c3', { text: 'y' });
  answer = async () => ({ ok: true });
  await reconnect();
  assert.deepEqual(saves.map((entry) => entry.conversationId), ['c2', 'c3'], 'the runtime answered both: nothing to write again');

  rpc.status.value = 'closed';
  answer = LOST;
  await save('c4', { text: 'first' });
  updateDraft('c4', { text: 'first and more' }); // the debounce is pending
  answer = async () => ({ ok: true });
  await reconnect();
  assert.equal(saves.length, 3, 'the pending change saves it, not the reconnect');
  flushDraft('c4');
  await tick();
  assert.deepEqual(saves.slice(3).map((entry) => entry.text), ['first and more']);
});
