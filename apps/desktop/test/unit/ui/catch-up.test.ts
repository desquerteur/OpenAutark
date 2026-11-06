// Catch-up after time away (src/ui/chat/catch-up.ts): the read cursor captured before markRead decides
// which messages are new; the divider sits before the first new non-silent message, and nothing shows in
// agent-only rooms or once the person wrote after it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationSummary, Member, Message, StatusLine } from '../../../src/shared/model/chat.ts';
import { captureStart, catchUp, isNew } from '../../../src/ui/chat/catch-up.ts';

const CHAT = 'ch_launch';
const T0 = Date.UTC(2026, 9, 1, 9, 0);
const MIN = 60_000;

function member(memberId: string, readSeq: number, extra: Partial<Member> = {}): Member {
  return { conversationId: CHAT, memberId, kind: memberId === 'human' ? 'human' : 'agent', role: 'member', readSeq, joinedAt: 0, ...extra };
}

function chat(unread: number, readSeq: number, extra: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: CHAT, title: 'Launch', titleNamed: true, createdBy: 'human', pinned: false, settings: {}, lastSeq: 0, createdAt: 0, updatedAt: 0,
    members: [member('human', readSeq), member('ag_manager', 0)], unread, working: [], openTasks: 0, ...extra,
  };
}

let nextSeq = 0;
function msg(authorId: string, extra: Partial<Message> = {}): Message {
  const seq = extra.seq ?? ++nextSeq;
  nextSeq = Math.max(nextSeq, seq);
  return {
    id: `msg_${seq}`, conversationId: CHAT, seq, authorId, authorKind: authorId === 'human' ? 'human' : authorId === 'system' ? 'system' : 'agent',
    kind: 'text', body: `message ${seq}`, attachments: [], mentions: [], priority: 'normal', state: 'final', silent: false, meta: {},
    createdAt: T0 + seq * MIN, ...extra,
  };
}

function status(type: StatusLine['type'], text: string, extra: Partial<Message> = {}): Message {
  return msg('system', { kind: 'status', silent: true, body: text, meta: { status: { type, text } }, ...extra });
}

/** A log: `old` read messages, then the person's message (the cursor), then `fresh` agent messages. */
function log(old: number, fresh: number, author = 'ag_manager'): { messages: Message[]; cursor: number } {
  nextSeq = 0;
  const messages: Message[] = [];
  for (let i = 0; i < old; i++) messages.push(msg(i % 2 ? 'human' : author));
  messages.push(msg('human'));
  const cursor = nextSeq;
  for (let i = 0; i < fresh; i++) messages.push(msg(author));
  return { messages, cursor };
}



test('captureStart: the person\'s cursor before markRead – only with something unread in a chat of the main list', () => {
  assert.deepEqual(captureStart(chat(3, 12)), { seq: 12 });
  assert.equal(captureStart(chat(0, 12)), null, 'nothing unread: no catch-up');
  assert.equal(captureStart(chat(3, 12, { settings: { hiddenFromList: true } })), null, 'agent-only room');
  assert.equal(captureStart(chat(3, 12, { members: [member('ag_manager', 0), member('ag_mia', 0)] })), null, 'no human member');
  assert.equal(captureStart(chat(3, 12, { members: [member('human', 12, { leftAt: 5 }), member('ag_manager', 0)] })), null, 'the person left');
  assert.equal(captureStart(chat(3, 12, { settings: { system: 'todo' } })), null, 'app-owned chat');
});

test('isNew follows the unread rule: after the cursor, not silent, not written by the person', () => {
  assert.equal(isNew(msg('ag_manager', { seq: 5 }), 4), true);
  assert.equal(isNew(msg('ag_manager', { seq: 4 }), 4), false, 'at the cursor');
  assert.equal(isNew(msg('human', { seq: 5 }), 4), false, 'the person\'s own');
  assert.equal(isNew(status('task_done', 'Done: x', { seq: 5 }), 4), false, 'silent status line');
});

test('the divider sits before the first new non-silent message and counts the new ones', () => {
  const { messages, cursor } = log(4, 6);
  messages.splice(messages.length - 6, 0, status('member_added', 'Added Mia', { seq: cursor + 0.5 }));
  const info = catchUp(messages, { seq: cursor });
  assert.equal(info?.dividerBefore, messages.find((message) => message.seq > cursor && !message.silent)!.id, 'skips the silent line');
  assert.equal(info?.count, 6);
});

test('no divider when the person wrote last, nothing is new, or no start was captured', () => {
  const { messages, cursor } = log(2, 8);
  const start = { seq: cursor };
  assert.ok(catchUp(messages, start));
  assert.equal(catchUp([...messages, msg('human')], start), null, 'the person wrote after the cursor');
  assert.equal(catchUp([...messages, msg('human', { kind: 'answer' })], start), null, 'a widget answer counts as writing');
  const quiet = log(3, 0);
  assert.equal(catchUp([...quiet.messages, status('note', 'Model switched')], { seq: quiet.cursor }), null, 'only silent lines after the cursor');
  assert.equal(catchUp(messages, null), null);
  assert.equal(catchUp([], start), null);
});
