// B-050 K1 regressions: a pair never gets a second default 1:1 – not after the first-run chat named after
// its agent (adopted), not after archiving it, and a member leaving ends the mark (it never moves to another pair).
// B-078 D7: a 1:1 stays two – work given there (a task owner) joins nothing, every add is refused with the
// first-person text, the owner's line in two agents' 1:1 posts without joining it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from './harness.ts';
import { findDirect, findOrCreateDirect, isDirect } from '../../../src/runtime/chat/direct.ts';
import { DIRECT_STAYS_TWO, DIRECT_STAYS_TWO_PERSON } from '../../../src/runtime/chat/members-change.ts';
import { chatTitleFor } from '../../../src/runtime/chat/titles.ts';
import { managerFirstChat } from '../../../src/shared/text/manager-chat.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';

function setup() {
  const h = harness();
  h.org.add(agent('ag_ada', 'Ada', { mode: 'manager' }));
  h.org.add(agent('ag_tom', 'Tom', { managerId: 'ag_ada' }));
  h.org.add(agent('ag_lea', 'Lea', { managerId: 'ag_ada' }));
  Object.assign(h.services, { settings: { get: () => ({ profile: { name: 'Mara' } }) } as unknown as RuntimeServices['settings'] });
  return h;
}

/** Marked chats whose pair is `a` and `b` (archived too). */
const defaults = (h: ReturnType<typeof harness>, a: string, b: string) => h.chats.list({ includeHidden: true })
  .filter((chat) => chat.settings.direct === true && [a, b].every((id) => chat.members.some((member) => member.memberId === id && !member.leftAt)))
  .filter((chat) => !chat.settings.directPair || chat.settings.directPair.includes(a) && chat.settings.directPair.includes(b));
const memberIds = (h: ReturnType<typeof harness>, id: string) => h.chats.members(id).map((member) => member.memberId).sort();

test('the first-run chat named after its agent becomes the default 1:1: no second "Ada"', () => {
  const h = setup();
  const seeded = h.chats.create({ title: 'Ada', agentIds: ['ag_ada'], createdBy: 'human' }); // runtime/main.ts on the first run
  h.chats.send({ conversationId: seeded.id, body: 'hello Ada', authorId: 'human', authorKind: 'human' });
  assert.equal(managerFirstChat(h.chats.list(), 'ag_ada')?.id, seeded.id, 'onboarding talks there');
  const direct = findOrCreateDirect(h.services, 'human', 'ag_ada', { createdBy: 'human' });
  assert.equal(direct, seeded.id, 'adopted: its title only names its agent');
  assert.equal(isDirect(h.chats.get(direct)!), true);
  assert.equal(managerFirstChat(h.chats.list(), 'ag_ada')?.id, direct, 'onboarding and "Message" agree');
  assert.equal(h.chats.list({ includeHidden: true }).length, 1);
  assert.equal(chatTitleFor(h.services, direct, 'human'), 'Ada');
  assert.equal(chatTitleFor(h.services, direct, 'ag_ada'), 'Mara', 'the agent sees the owner\'s name, never its own');
});

test('D7: work given in the default 1:1 joins nobody; an add is refused; it stays the pair\'s one default', () => {
  const h = setup();
  const d = findOrCreateDirect(h.services, 'human', 'ag_ada', { createdBy: 'human' });
  h.chats.send({ conversationId: d, body: 'Ada, please get the site redone', authorId: 'human', authorKind: 'human' });
  h.tasks.create({ conversationId: d, title: 'Redo the site', assigneeKind: 'agent', assigneeId: 'ag_tom', createdBy: 'ag_ada' }); // tasks/owners.ts joinChat
  assert.deepEqual(memberIds(h, d), ['ag_ada', 'human'], 'Tom did not join the 1:1');
  assert.throws(() => h.chats.setMembers(d, { add: ['ag_lea'] }, 'ag_ada'), (error: Error & { code?: string }) => error.code === 'conflict' && error.message === DIRECT_STAYS_TWO);
  assert.throws(() => h.chats.setMembers(d, { add: ['ag_lea'] }, 'human'), (error: Error) => error.message === DIRECT_STAYS_TWO_PERSON, 'the person reads the window’s words, not an agent’s tool hint');
  assert.deepEqual(memberIds(h, d), ['ag_ada', 'human'], 'nothing changed');
  assert.equal(isDirect(h.chats.get(d)!), true);
  assert.equal(findOrCreateDirect(h.services, 'human', 'ag_ada', { createdBy: 'human' }), d, '"Message" on Ada opens the chat with her history');
  assert.equal(managerFirstChat(h.chats.list(), 'ag_ada')?.id, d, 'the manager reports there');
  assert.equal(defaults(h, 'human', 'ag_ada').length, 1);
  // a bridged outside contact is the chat's channel, not a third partner: it still joins
  h.chats.setMembers(d, { add: ['ext:tg:42:Sam'] }, 'system');
  assert.equal(isDirect(h.chats.get(d)!), true);
});

test('D7: the owner writing in the 1:1 of two agents posts there without joining it', () => {
  const h = setup();
  const pair = findOrCreateDirect(h.services, 'ag_ada', 'ag_tom', { createdBy: 'ag_ada' });
  h.chats.send({ conversationId: pair, body: 'Both of you: the launch moved to Friday', authorId: 'human', authorKind: 'human' });
  assert.deepEqual(memberIds(h, pair), ['ag_ada', 'ag_tom']);
  assert.equal(isDirect(h.chats.get(pair)!), true);
  assert.equal(h.chats.messages(pair).at(-1)?.body, 'Both of you: the launch moved to Friday');
});

test('archived, the default 1:1 stays the only one – also once it is back', () => {
  const h = setup();
  const d = findOrCreateDirect(h.services, 'human', 'ag_tom', { createdBy: 'human' });
  h.chats.send({ conversationId: d, body: 'history', authorId: 'human', authorKind: 'human' });
  h.chats.archive(d);
  assert.equal(findOrCreateDirect(h.services, 'human', 'ag_tom', { createdBy: 'human' }), d);
  h.chats.unarchive(d);
  assert.deepEqual(defaults(h, 'human', 'ag_tom').map((chat) => chat.id), [d]);
});

test('a member leaving ends the mark: it never passes to another pair, and then the chat takes members again', () => {
  const h = setup();
  const d = findOrCreateDirect(h.services, 'human', 'ag_tom', { createdBy: 'human' });
  const leas = findOrCreateDirect(h.services, 'human', 'ag_lea', { createdBy: 'human' });
  assert.throws(() => h.chats.setMembers(d, { add: ['ag_lea'], remove: ['ag_tom'] }, 'human'), /A 1:1 stays two. For more people, start a group with them./, 'a swap is an add: refused');
  h.chats.setMembers(d, { remove: ['ag_tom'] }, 'human');
  assert.equal(isDirect(h.chats.get(d)!), false);
  h.chats.setMembers(d, { add: ['ag_lea'] }, 'human');
  assert.deepEqual(defaults(h, 'human', 'ag_lea').map((chat) => chat.id), [leas], 'Lea keeps one default 1:1');
  const toms = findOrCreateDirect(h.services, 'human', 'ag_tom', { createdBy: 'human' });
  assert.notEqual(toms, d);
  assert.deepEqual(memberIds(h, toms), ['ag_tom', 'human']);
});

test('an older mark without its stored pair (an import) gets the pair on its first member change', () => {
  const h = setup();
  const old = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human', settings: { direct: true } });
  assert.equal(findDirect(h.services, 'human', 'ag_tom'), old.id);
  h.chats.setMembers(old.id, { add: ['ext:tg:42:Sam'] }, 'human');
  assert.deepEqual(h.chats.get(old.id)!.settings.directPair, ['ag_tom', 'human']);
  assert.equal(findDirect(h.services, 'human', 'ag_tom'), old.id);
  assert.equal(findDirect(h.services, 'human', 'ag_lea'), undefined);
});
