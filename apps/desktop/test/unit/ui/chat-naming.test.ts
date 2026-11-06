// B-050 K2 in the UI (src/ui/lib/chat-naming.ts): a chat's name, partner and second line as the caller
// ('human') sees it – the default 1:1 by its partner, a topic chat as "Name · Topic", a group by its
// other members; and the UI's own label where the shared rule knows no name (a default 1:1 whose partner
// was removed, or a person whose access ended): "Untitled chat", never a blank.
// Owns: these assertions. Never: renders (the face: lib/chat-face.tsx, checked in test/ui/team-chats-window).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationSummary, Member } from '../../../src/shared/model/chat.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { Person } from '../../../src/shared/model/people.ts';
import { UNTITLED_CHAT, chatPartner, chatSubtitle, chatTitle } from '../../../src/ui/lib/chat-naming.ts';
import { agents, archivedAgents } from '../../../src/ui/lib/store.ts';
import { people } from '../../../src/ui/lib/people.ts';

agents.value = [
  { id: 'ag_lena', name: 'Lena', role: 'Research' } as Agent,
  { id: 'ag_ravi', name: 'Ravi', role: 'Writing' } as Agent,
];
people.value = [{ id: 'per_anna0000001', name: 'Anna', title: 'Design' } as Person];

function member(memberId: string, patch: Partial<Member> = {}): Member {
  return { conversationId: 'ch_1', memberId, kind: memberId.startsWith('ag_') ? 'agent' : 'human', role: 'member', readSeq: 0, joinedAt: 0, ...patch };
}

function chat(members: Member[], patch: Partial<ConversationSummary> = {}): ConversationSummary {
  return { id: 'ch_1', title: '', titleNamed: false, settings: {}, members, createdBy: 'human', pinned: false, lastSeq: 0, createdAt: 0, updatedAt: 0, unread: 0, working: [], openTasks: 0, ...patch } as ConversationSummary;
}

test('chatTitle: the default 1:1 by its partner, a topic chat as "Name · Topic", a group by its other members', () => {
  const direct = chat([member('human'), member('ag_lena')], { settings: { direct: true } });
  assert.equal(chatTitle(direct), 'Lena');
  assert.equal(chatPartner(direct)?.memberId, 'ag_lena');
  assert.equal(chatSubtitle(direct), 'Research');
  assert.equal(chatTitle(chat([member('human'), member('ag_lena')], { title: 'Video edit', titleNamed: true })), 'Lena · Video edit');
  const group = chat([member('human'), member('ag_lena'), member('per_anna0000001')]);
  assert.equal(chatTitle(group), 'Lena, Anna', 'an untitled group: the other members');
  assert.equal(chatSubtitle(group), '2 members');
});

test('chatTitle: a chat nobody can name – a default 1:1 whose partner was removed – gets a label, never a blank', () => {
  // A summary lists its active members only (runtime chat/summary.ts): the removed partner is gone from it.
  const left = chat([member('human')]);
  assert.equal(chatTitle(left), UNTITLED_CHAT, 'no blank row, header or "Message " placeholder');
  assert.equal(chatPartner(left), undefined, 'no partner to open');
  assert.equal(chatSubtitle(left), '');
  assert.equal(chatTitle(chat([member('human'), member('ag_lena', { leftAt: 5 })])), UNTITLED_CHAT, 'a left member names nothing');
  assert.equal(chatTitle(chat([member('human')], { title: 'Lena' })), 'Lena', 'a stored title still names it');
  assert.equal(chatTitle(chat([member('human')], { title: 'Q3 plan', titleNamed: true })), 'Q3 plan');
});

test('chatTitle: the default 1:1 of an archived agent keeps its agent name and role (agents.list leaves archived agents out)', () => {
  archivedAgents.value = [{ id: 'ag_otto', name: 'Otto', role: 'Support', archivedAt: 9 } as Agent];
  try {
    const direct = chat([member('human'), member('ag_otto')], { settings: { direct: true } });
    assert.equal(chatTitle(direct), 'Otto', 'not "Untitled chat"');
    assert.equal(chatPartner(direct)?.memberId, 'ag_otto');
    assert.equal(chatSubtitle(direct), 'Support');
    assert.equal(chatTitle(chat([member('human'), member('ag_otto')], { title: 'Refunds', titleNamed: true })), 'Otto · Refunds');
  } finally { archivedAgents.value = []; }
  assert.equal(chatTitle(chat([member('human'), member('ag_otto')], { settings: { direct: true } })), UNTITLED_CHAT, 'a restored or removed agent is not remembered');
});
