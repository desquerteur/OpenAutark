// C6 leftovers (INT-13): the notice an edit or delete of the person leaves for agents is a row only
// agents read – it keeps the chat's place in the person's list (ConversationRepo.nextSeq quiet) and
// stays out of the person's other views: `wf read`
// (wf-cli/format.ts) and `wf watch` (wf-cli/stream.ts; with --json too, so --count counts only
// lines the person sees). The tombstone of a deleted message stays.
// Owns: these assertions only. Never: a real engine, window or runtime process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../context/fixture.ts';
import { formatMessages } from '../../../src/runtime/wf-cli/format.ts';
import { isAgentNotice, tombstoneOf } from '../../../src/shared/model/message-changes.ts';
import { message } from '../cli/fixtures.ts';
import { fakeRuntime, launch, manager, wf } from '../cli/fake-runtime.ts';

function setup() {
  const f = fixture();
  const group = f.chats.create({ title: 'Launch', agentIds: [f.manager.id, f.vid.id], createdBy: 'human' });
  const other = f.chats.create({ title: 'Budget', agentIds: [f.manager.id], createdBy: 'human' });
  return { ...f, group, other };
}

test("an edit or delete notice keeps the chat's place in the person's list and its updatedAt", () => {
  const f = setup();
  const mine = f.chats.send({ conversationId: f.group.id, body: 'Ship on Fridy', authorId: 'human' });
  const typo = f.chats.send({ conversationId: f.group.id, body: 'typo', authorId: 'human' });
  const before = f.chats.get(f.group.id)!;
  f.clock.advance(60_000);
  f.chats.send({ conversationId: f.other.id, body: 'Numbers are in.', authorId: f.manager.id });
  const order = () => f.chats.list().map((chat) => chat.id).filter((id) => id === f.group.id || id === f.other.id);
  assert.deepEqual(order(), [f.other.id, f.group.id]);

  f.clock.advance(60_000);
  f.chats.edit(mine.id, 'Ship on Friday', 'human');
  f.clock.advance(60_000);
  f.chats.removeMessage(typo.id, 'human');
  const notices = f.chats.messages(f.group.id).filter((line) => isAgentNotice(line));
  assert.equal(notices.length, 2, 'agents still get both notices');
  const after = f.chats.get(f.group.id)!;
  assert.equal(after.lastSeq, notices[1].seq, 'each notice takes the next seq');
  assert.deepEqual([after.lastMessageAt, after.updatedAt], [before.lastMessageAt, before.updatedAt], 'neither notice moved the chat');
  assert.deepEqual(order(), [f.other.id, f.group.id], 'the chat keeps its place in the list');
  assert.equal(f.chats.summary(f.group.id).lastPreview?.text, 'Ship on Friday', 'the preview is the edited message');
});

test("wf read leaves agents' notices out; the tombstone stays", () => {
  const f = setup();
  const mine = f.chats.send({ conversationId: f.group.id, body: 'Budget is 6k', authorId: 'human' });
  const gone = f.chats.send({ conversationId: f.group.id, body: 'Wrong chat', authorId: 'human' });
  f.chats.edit(mine.id, 'Budget is 7k', 'human');
  f.chats.removeMessage(gone.id, 'human');
  const log = f.chats.messages(f.group.id);
  assert.equal(log.filter((line) => isAgentNotice(line)).length, 2);
  assert.ok(log.some((row) => tombstoneOf(row) === gone.id), 'the tombstone is kept');

  const lines = formatMessages(log, (id) => (id === 'human' ? 'You' : id), f.clock.now()).join('\n');
  assert.doesNotMatch(lines, /was (edited|deleted)/);
  assert.match(lines, /Budget is 7k/);
  assert.match(lines, /Message deleted/);
  assert.deepEqual(formatMessages(log.filter((line) => isAgentNotice(line)), (id) => id, f.clock.now()), ['No messages.']);
});

test('wf watch skips a pushed notice and prints the next message, with --json too', async (t) => {
  const topic = `chat:${launch.id}`;
  const notice = message({
    id: 'msg_notice', seq: 11, conversationId: launch.id, authorId: 'system', authorKind: 'system', kind: 'status', silent: true,
    body: 'Message #10 was edited', meta: { status: { type: 'note', text: 'Message #10 was edited', details: { edited: 'msg_10', seq: 10 } } },
  });
  const runtime = await fakeRuntime({
    'events.subscribe': (params, fake) => {
      setTimeout(() => {
        if (!(params as { topics: string[] }).topics.includes(topic)) return;
        fake.push('message.created', notice, topic);
        fake.push('message.created', message({ id: 'msg_reply', seq: 12, conversationId: launch.id, authorId: manager.id, authorKind: 'agent', body: 'Got it' }), topic);
      }, 20);
      return { ok: true };
    },
  });
  t.after(() => runtime.stop());
  const watched = await wf(['watch', 'Launch', '--count', '1'], { runtime });
  assert.equal(watched.code, 0, watched.err);
  assert.equal(watched.out, '14:02  Manager: Got it\n');
  const json = await wf(['watch', 'Launch', '--count', '1', '--json'], { runtime });
  assert.equal(json.code, 0, json.err);
  assert.deepEqual(json.out.trim().split('\n').map((line) => (JSON.parse(line) as { id: string }).id), ['msg_reply']);
});
