// B-050 K1, Nachtrag Runde 4 in the window: every agent has the owner's default 1:1 from the hire on, so the chat
// list (src/ui/chat/list-order.ts, ChatList.tsx) keeps an empty one below every chat with a line – newest first, then
// by name; pinned stays first, a new chat that is not a default 1:1 keeps its place by creation, and a default 1:1
// moves up with its first line – and Team's "Most used" (src/ui/team/model.ts interactionScores) counts no empty chat.
// The New task picker (byActivity) keeps the same rule – after the start-up backfill an empty default 1:1 sat above
// older real chats there.
// Owns: these assertions. Never: renders (the row's look: ChatRow.tsx, checked in the window).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationSummary, Member } from '../../../src/shared/model/chat.ts';
import { byActivity, emptyDirect, orderChats } from '../../../src/ui/chat/list-order.ts';
import { interactionScores } from '../../../src/ui/team/model.ts';

const NOW = Date.UTC(2026, 9, 29, 9);
const HOUR = 3_600_000;

type Row = Pick<ConversationSummary, 'id' | 'title' | 'pinned' | 'settings' | 'lastMessageAt' | 'createdAt' | 'members'>;

function member(memberId: string): Member {
  return { conversationId: 'c', memberId, kind: memberId === 'human' ? 'human' : 'agent', role: 'member', readSeq: 0, joinedAt: 0 } as Member;
}

function row(id: string, over: Partial<Row> = {}): Row {
  return { id, title: id, pinned: false, settings: {}, createdAt: NOW - 10 * HOUR, members: [member('human'), member(`ag_${id}`)], ...over };
}

const direct = (id: string, createdAt: number, lastMessageAt?: number): Row =>
  row(id, { settings: { direct: true, directPair: ['ag_' + id, 'human'] }, createdAt, ...(lastMessageAt === undefined ? {} : { lastMessageAt }) });

test('emptyDirect: a default 1:1 nobody wrote in yet', () => {
  assert.equal(emptyDirect(direct('mira', NOW)), true);
  assert.equal(emptyDirect(direct('mira', NOW, NOW)), false, 'a line was written');
  assert.equal(emptyDirect(row('launch')), false, 'not a default 1:1');
});

test('orderChats: empty default 1:1s wait below every chat with a line, newest first, then by name', () => {
  const list = [
    direct('ada', NOW - 1), // the start-up backfill made these at one moment …
    direct('zoe', NOW - 1),
    direct('ben', NOW - 1),
    direct('lea', NOW), // … and a hire later
    direct('mira', NOW - 50 * HOUR, NOW - 30 * HOUR), // a default 1:1 with an old line
    row('launch', { lastMessageAt: NOW - 2 * HOUR }),
    row('fresh', { createdAt: NOW - HOUR }), // a new chat the person started: no default 1:1, by its creation
    row('pinned', { pinned: true, lastMessageAt: NOW - 90 * HOUR }),
  ];
  const names = (chat: Row) => chat.title;
  assert.deepEqual(orderChats(list, names).map((chat) => chat.id), ['pinned', 'fresh', 'launch', 'mira', 'lea', 'ada', 'ben', 'zoe']);
  assert.deepEqual(list[0].id, 'ada', 'the input stays as it was');

  // Its first line moves the chat up, like any chat.
  const written = list.map((chat) => (chat.id === 'zoe' ? { ...chat, lastMessageAt: NOW } : chat));
  assert.deepEqual(orderChats(written, names).map((chat) => chat.id).slice(0, 2), ['pinned', 'zoe']);
});

test('byActivity: an empty default 1:1 waits below every chat with a line there too', () => {
  const full = (chat: Row) => ({ ...chat, members: chat.members.map((m) => ({ ...m })) }) as unknown as ConversationSummary;
  // The backfill made the default 1:1s now; the real chats are older.
  const beaDm = full(direct('bea', NOW));
  const cyDm = full(direct('cy', NOW - 1));
  const sources = full(row('sources', { members: [member('human'), member('ag_cy')], lastMessageAt: NOW - 30 * HOUR }));
  const old = full(row('old', { members: [member('human'), member('ag_bea')], createdAt: NOW - 90 * HOUR }));

  assert.deepEqual([beaDm, cyDm, sources, old].sort(byActivity).map((chat) => chat.id), ['sources', 'old', 'bea', 'cy'], 'the New task picker');
});

test('interactionScores: an empty default 1:1 is no interaction ("Most used" stays what the person used)', () => {
  const scores = interactionScores([
    { members: [member('human'), member('ag_new')], createdAt: NOW },
    { members: [member('human'), member('ag_used')], createdAt: NOW - 40 * 24 * HOUR, lastMessageAt: NOW - 20 * 24 * HOUR },
  ], NOW);
  assert.equal(scores.get('ag_new'), undefined, 'hired today, never written to');
  assert.ok((scores.get('ag_used') ?? 0) > 0);
});
