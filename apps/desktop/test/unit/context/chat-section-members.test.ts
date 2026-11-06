// B-050 K2/K3/K5 – the volatile prompt's "## This chat" line (context/prompt-volatile.ts chatSection): the title as the
// agent sees it (shared/text/chat-names.ts displayTitle), every room of two "1:1 chat with <name>" whoever the other
// member is (the CEO, a colleague, another agent, an external member), a larger room a group of peers.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVolatile } from '../../../src/runtime/context/prompt-volatile.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';

const CHAT = 'ch_room0000001';
const AVA = { id: 'ag_ava', name: 'Ava' } as Agent;

const kindOf = (id: string) => (id === HUMAN_ID || id.startsWith('per_') ? 'human' : id.startsWith('ext:') ? 'external' : 'agent');
const INTERNAL = 'internal room of us agents – Alex gets nothing from here; what Alex should know goes to my 1:1 with Alex';

interface Line { members: string[]; title?: string; titleNamed?: boolean; direct?: boolean; profileName?: string; lead?: string; parentId?: string; anchorId?: string }

function chatLine(input: Line): string {
  const settings = { ...(input.direct ? { direct: true } : {}), ...(input.parentId ? { parentId: input.parentId } : {}), ...(input.anchorId ? { anchorId: input.anchorId } : {}) };
  const chats: Record<string, unknown> = {
    [CHAT]: { id: CHAT, title: input.title ?? '', titleNamed: input.titleNamed ?? false, settings },
    ch_parent00001: { id: 'ch_parent00001', title: 'Launch', titleNamed: true, settings: {} },
  };
  const services = {
    chats: {
      get: (id: string) => chats[id],
      members: () => input.members.map((memberId) => ({ conversationId: CHAT, memberId, kind: kindOf(memberId) })),
      lead: () => input.lead,
      message: (id: string) => (id === 'msg_anchor' ? { id, seq: 12 } : undefined),
    },
    settings: { get: () => ({ profile: { name: input.profileName ?? 'Alex' } }) },
    org: { get: (id: string) => ({ ag_ava: { id, name: 'Ava' }, ag_bob: { id, name: 'Bob' } } as Record<string, unknown>)[id] },
    people: { get: (id: string) => (id === 'per_anna000001' ? { id, name: 'Anna Berg', title: 'Designer' } : undefined) },
  } as unknown as RuntimeServices;
  const text = buildVolatile(services, { agent: AVA, conversationId: CHAT, route: {} as never });
  return text.split('\n').find((line) => line.includes(`(${CHAT})`)) ?? text;
}

test('a room of two is a 1:1 with whoever the other member is; a 1:1 says it stays two and what it is for', () => {
  assert.equal(chatLine({ members: ['ag_ava', HUMAN_ID], direct: true }), `Alex (${CHAT}) · 1:1 chat with Alex (CEO) · it stays us two; what Alex needs from me goes here`);
  assert.equal(chatLine({ members: ['ag_ava', 'ag_bob'], direct: true }), `Bob (${CHAT}) · 1:1 chat with Bob · it stays us two · ${INTERNAL}`, 'agent and agent: an internal room');
  assert.equal(chatLine({ members: ['ag_ava', 'per_anna000001'], direct: true }), `Anna Berg (${CHAT}) · 1:1 chat with Anna Berg (colleague, Designer) [per_anna000001] · it stays us two · Alex is not in this chat`, 'F-52: the owner-only fact stays a note');
  assert.equal(chatLine({ members: ['ag_ava', 'ext:api:0123456789:Research-Bot'] }), `Research-Bot (external agent) (${CHAT}) · 1:1 chat with Research-Bot (external agent)`);
  assert.equal(chatLine({ members: ['ag_ava', 'ag_bob'], title: 'Teaser cut', titleNamed: true }), `Bob · Teaser cut (${CHAT}) · 1:1 chat with Bob · ${INTERNAL}`, 'a topic chat of the two');
  assert.equal(chatLine({ members: ['ag_ava', HUMAN_ID], profileName: '' }), `the CEO (${CHAT}) · 1:1 chat with the CEO`, 'no profile name, no 1:1 mark');
});

test('a larger room is a group of peers; the lead note only there; only me when alone', () => {
  assert.equal(chatLine({ members: ['ag_ava', 'ag_bob', HUMAN_ID, 'per_anna000001'], title: 'Launch', titleNamed: true, lead: 'ag_ava' }),
    `Launch (${CHAT}) · group with Alex (CEO), Anna Berg (colleague, Designer) [per_anna000001], Bob · a discussion among peers Alex takes part in · I am the lead (I answer un-addressed messages)`);
  assert.equal(chatLine({ members: ['ag_ava', 'ag_bob', 'per_anna000001'] }),
    `Bob, Anna Berg (${CHAT}) · group with Anna Berg (colleague, Designer) [per_anna000001], Bob · a discussion among peers · Alex is not in this chat`, 'an untitled group is named after the others');
  assert.equal(chatLine({ members: ['ag_ava'], title: 'Scratch', titleNamed: true }), `Scratch (${CHAT}) · only me · ${INTERNAL}`);
});

test('B-078: a sub-chat names its parent, a thread the message it answers', () => {
  assert.equal(chatLine({ members: ['ag_ava', HUMAN_ID, 'ag_bob'], title: 'Design', titleNamed: true, parentId: 'ch_parent00001' }),
    `Design (${CHAT}) · group with Alex (CEO), Bob · a discussion among peers Alex takes part in · sub-chat of "Launch" (ch_parent00001)`);
  assert.equal(chatLine({ members: ['ag_ava', 'ag_bob'], title: 'Logo', titleNamed: true, parentId: 'ch_parent00001', anchorId: 'msg_anchor' }),
    `Bob · Logo (${CHAT}) · 1:1 chat with Bob · ${INTERNAL} · thread on #12 of "Bob · Launch" (ch_parent00001) – the work on that message goes here`);
});
