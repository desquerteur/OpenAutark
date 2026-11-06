// F-52 wave 2 (UI): on a person's device a file for a chat goes up chunked with that chat's id (the runtime takes
// people's files only into their chats); the owner's uploads are unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FileRef } from '../../../src/shared/model/system.ts';
import { uploadRef } from '../../../src/ui/lib/files.ts';
import type { UploadRpc } from '../../../src/ui/lib/files.ts';
import { session } from '../../../src/ui/lib/session.ts';

function fakeRpc() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const via = {
    async call(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      const ref = { id: 'b'.repeat(64), name: String(params.name), mime: 'text/plain', size: 3, createdAt: 1 } as FileRef;
      return method === 'files.upload' ? ref : { received: 3, file: ref };
    },
  } as unknown as UploadRpc;
  return { via, calls };
}

test('a person\'s file for a chat goes chunked with the chat id; the owner\'s small file stays inline', async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'text/plain' });
  session.value = { kind: 'person', capabilities: ['todo', 'chat', 'tasks'], secure: true, allowedMethods: ['files.uploadChunk'] } as never;
  const person = fakeRpc();
  await uploadRef(blob, 'a.txt', person.via, undefined, { conversationId: 'ch_1' });
  assert.equal(person.calls[0].method, 'files.uploadChunk');
  assert.equal(person.calls[0].params.conversationId, 'ch_1');
  assert.equal(person.calls[0].params.final, true);

  session.value = { kind: 'owner', capabilities: [], secure: true, allowedMethods: [] } as never;
  const owner = fakeRpc();
  await uploadRef(blob, 'a.txt', owner.via, undefined, { conversationId: 'ch_1' });
  assert.equal(owner.calls[0].method, 'files.upload');
  assert.equal(owner.calls[0].params.conversationId, undefined);
  session.value = null;
});
