// References (runtime/references/references.ts): "Remember why…" turns the caller's own text message and the typed
// reason into memory files in references/<whose>/ ("Example: …", "Reason: …"); repeating it replaces them; another
// author's message is refused; every agent finds references through knowledge search, references.find narrows to one
// person's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { KnowledgeStore } from '../../../src/runtime/knowledge/service.ts';
import { captureReference, findReferences, rememberWhy } from '../../../src/runtime/references/references.ts';
import type { Message } from '../../../src/shared/model/chat.ts';

function world() {
  const db = new Db(':memory:');
  migrate(db);
  const clock = new ManualClock();
  const knowledge = new KnowledgeStore({ db, clock });
  const messages = new Map<string, Message>([
    ['msg_own', { id: 'msg_own', authorKind: 'human', authorId: 'human', kind: 'text', state: 'final', body: 'We ship on Friday, no earlier.' } as Message],
    ['msg_agent', { id: 'msg_agent', authorKind: 'agent', authorId: 'ag_a', kind: 'text', state: 'final', body: 'Done.' } as Message],
  ]);
  const chats = { message: (id: string) => messages.get(id) };
  return { db, knowledge, chats };
}

test('Remember why: an example and a reason; a repeat replaces them; only own text messages', async () => {
  const w = world();
  const made = await rememberWhy(w, { messageId: 'msg_own', why: 'Weekend deploys go wrong.', whyKind: 'reason', keepExample: true }, 'human');
  assert.deepEqual(made.map((item) => item.title), ['Example: We ship on Friday, no earlier.', 'Reason: Weekend deploys go wrong.']);
  assert.ok(made.every((item) => item.scope === 'reference' && item.scopeId === 'human' && item.kind === 'reference'));
  const again = await rememberWhy(w, { messageId: 'msg_own', why: 'Support is off at weekends.' }, 'human');
  assert.equal(again[1].supersedes, made[1].id, 'the reason is replaced, not repeated');
  assert.equal((await w.knowledge.list({ scope: 'reference' })).length, 2);
  await assert.rejects(() => rememberWhy(w, { messageId: 'msg_agent', why: 'x' }, 'human'), /own text messages/);
  await assert.rejects(() => rememberWhy(w, { messageId: 'msg_none', why: 'x' }, 'human'), /not found/i);
});

test('every agent finds references; references.find narrows to one person', async () => {
  const w = world();
  captureReference(w.knowledge, { kind: 'style', text: 'Short answers, the next step first.', by: 'ag_a' });
  captureReference(w.knowledge, { kind: 'style', text: 'Long answers with every detail.', subject: 'per_anna', by: 'ag_a' });
  const recalled = await w.knowledge.search({ text: 'answers', agentId: 'ag_b' });
  assert.equal(recalled.length, 2, 'an agent reads every reference through recall');
  const owners = await findReferences(w.knowledge, { text: 'answers', subject: 'human' });
  assert.deepEqual(owners.map((hit) => hit.item.body), ['Short answers, the next step first.']);
});
