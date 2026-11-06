// D4/D5 in the UI store (src/ui/lib/store.ts putMessage): a known message that comes back with a new
// seq – a run's answer moved to the end of the chat when it was finished – is re-sorted, so it renders
// below the approvals, status lines and posts of its run. Root cause fixed: a known id was replaced in
// place and kept its old position. Owns: these assertions only (rpc is a fake).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../../../src/shared/model/chat.ts';
import { rpc } from '../../../src/ui/lib/rpc.ts';

(rpc as unknown as { onOpen: unknown }).onOpen = () => () => undefined;
(rpc as unknown as { call: unknown }).call = async () => ({ ok: true });
const { messagesFor, putMessage } = await import('../../../src/ui/lib/store.ts');

const row = (seq: number, patch: Partial<Message> = {}) => ({
  id: `msg_${seq}`, conversationId: 'cv_reseq', seq, authorId: 'human', authorKind: 'human', kind: 'text', body: `#${seq}`, attachments: [], mentions: [],
  priority: 'normal', state: 'final', silent: false, meta: {}, createdAt: seq, ...patch,
}) as Message;

test('a finished answer with a new seq moves below what its run posted; an update with the same seq stays in place', () => {
  const list = messagesFor('cv_reseq');
  const answer = row(2, { id: 'msg_answer', authorId: 'ag_tom', authorKind: 'agent', state: 'streaming', runId: 'run_1', body: '' });
  list.value = [row(1), answer, row(3, { kind: 'task' }), row(4, { kind: 'status' })];
  putMessage({ ...answer, body: 'Hel' });
  assert.deepEqual(list.value.map((message) => message.id), ['msg_1', 'msg_answer', 'msg_3', 'msg_4'], 'same seq: replaced in place');
  putMessage({ ...answer, seq: 5, state: 'final', body: 'Hello' });
  assert.deepEqual(list.value.map((message) => message.id), ['msg_1', 'msg_3', 'msg_4', 'msg_answer'], 're-sorted to its new seq');
  assert.equal(list.value[3].body, 'Hello');
});
