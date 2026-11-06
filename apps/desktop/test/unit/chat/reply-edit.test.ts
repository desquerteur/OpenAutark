// C6 – reply, edit and delete (chat/service.ts, chat/message-edits.ts, context/render.ts,
// shared/model/message-changes.ts): a reply names a message of its own chat only and, as the
// person's text without an @mention, addresses the agent replied to (a receipt never); the person
// edits only their own text messages; each edit or delete in a chat with agents posts a quiet notice
// that agents read as "edited #seq" (the current text, the newest notice only) or "deleted their
// message from <time>"; the person's deleted message leaves a tombstone at its place; agents read
// whom a reply answers; the shared markers tell notices, tombstones and gone quotes apart; an
// important reply steered into a running turn keeps its quote and the notices before it.
// Owns: these assertions. Never: a real engine or window (the e2e runtime-reply and the window test do).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from '../context/fixture.ts';
import { renderMessages } from '../../../src/runtime/context/render.ts';
import { renderContext } from '../../../src/runtime/context/delta.ts';
import { steerInput } from '../../../src/runtime/agents/dispatch-steer.ts';
import { isAgentNotice, personalText, quotedIn, tombstoneOf } from '../../../src/shared/model/message-changes.ts';
import type { Message } from '../../../src/shared/model/chat.ts';

/** agents/dispatch-steer.ts renders notices and reply lines through context/render.ts (an edit for that file's owner, C6 open point). */
const steerWired = readFileSync(new URL('../../../src/runtime/agents/dispatch-steer.ts', import.meta.url), 'utf8').includes('changeNotice(');

function setup() {
  const f = fixture();
  const group = f.chats.create({ title: 'Launch', agentIds: [f.manager.id, f.vid.id], createdBy: 'human' });
  const say = (body: string, authorId = 'human', extra: { replyTo?: string; mentions?: string[]; priority?: Message['priority'] } = {}) =>
    f.chats.send({ conversationId: group.id, body, authorId, ...extra });
  const statusLines = () => f.chats.messages(group.id).filter((message) => message.kind === 'status');
  const delta = (agentId: string, sinceSeq: number) =>
    f.context.delta({ agent: agentId === f.vid.id ? f.vid : f.manager, conversationId: group.id, sinceSeq, full: false }).text;
  return { ...f, group, say, statusLines, delta };
}

test('a reply keeps a message of its own chat only; the person replying to an agent addresses that agent', () => {
  const f = setup();
  const other = f.chats.create({ title: 'Elsewhere', agentIds: [f.manager.id], createdBy: 'human' });
  const secret = f.chats.send({ conversationId: other.id, body: 'Salary list', authorId: 'human' });
  const cut = f.say('Rough cut is ready.', f.vid.id);
  const reply = f.say('Make it shorter', 'human', { replyTo: cut.id });
  assert.equal(reply.replyTo, cut.id);
  assert.deepEqual(reply.mentions, [f.vid.id], 'Vic is addressed, not the lead');
  assert.ok(f.wakeRows().some((row) => row.agent_id === f.vid.id && row.conversation_id === f.group.id));
  assert.equal(f.say('See this', 'human', { replyTo: secret.id }).replyTo, undefined, "another chat's message is never quoted");
  const named = f.say('@Mia please check', 'human', { replyTo: cut.id });
  assert.deepEqual(named.mentions, [f.manager.id], 'an explicit @mention wins over the reply');
  assert.deepEqual(f.say('Agreed', f.manager.id, { replyTo: cut.id }).mentions, [], "an agent's reply addresses nobody by itself");
  // An answer receipt (tasks/answer-receipt.ts) quotes the ask it answers, but the person mentioned no one.
  const receipt = f.chats.send({ conversationId: f.group.id, body: 'Short', kind: 'answer', authorId: 'human', authorKind: 'human', replyTo: cut.id });
  assert.equal(receipt.replyTo, cut.id);
  assert.deepEqual(receipt.mentions, [], 'a receipt keeps no mention the person never made');
});

test('the person edits only their own text messages; an agent only its own', () => {
  const f = setup();
  const mine = f.say('Ship on Fridy');
  const theirs = f.say('Done.', f.vid.id);
  assert.throws(() => f.chats.edit(theirs.id, 'Not done', 'human'), (error: { code?: string }) => error.code === 'forbidden');
  const line = f.chats.status(f.group.id, { type: 'note', text: 'Switched mode' });
  assert.throws(() => f.chats.edit(line.id, 'x', 'human'), (error: { code?: string }) => error.code === 'forbidden');
  assert.throws(() => f.chats.edit(mine.id, 'x', f.vid.id), (error: { code?: string }) => error.code === 'forbidden');
  assert.equal(f.chats.edit(theirs.id, 'Done, uploaded.', f.vid.id).body, 'Done, uploaded.');
  assert.equal(f.chats.message(theirs.id)?.body, 'Done, uploaded.');
  const unchanged = f.chats.edit(mine.id, 'Ship on Fridy', 'human');
  assert.equal(unchanged.editedAt, undefined, 'the same text is no edit');
  f.clock.advance(5_000);
  const edited = f.chats.edit(mine.id, 'Ship on Friday', 'human');
  assert.equal(edited.editedAt, f.clock.now());
  assert.ok(f.of('message.updated').some((message) => message.id === mine.id && message.body === 'Ship on Friday'));
});

test('each edit in a chat with agents posts a quiet notice; agents read the current text once, as "edited #seq"', () => {
  const f = setup();
  const mine = f.say('Budget is 5k');
  f.say('Noted.', f.manager.id);
  for (const agentId of [f.manager.id, f.vid.id]) f.chats.markRead(f.group.id, agentId, f.chats.get(f.group.id)!.lastSeq);
  const seen = f.chats.get(f.group.id)!.lastSeq;
  f.chats.edit(mine.id, 'Budget is 6k', 'human');
  f.chats.edit(mine.id, 'Budget is 7k', 'human');
  const notices = f.statusLines().filter((message) => message.meta.status?.details?.edited === mine.id);
  assert.equal(notices.length, 2, 'every edit is told – a running turn may have read the first notice already');
  assert.ok(notices.every((notice) => notice.silent && notice.meta.status?.details?.seq === mine.seq));
  assert.equal(f.delta(f.vid.id, seen), `· Alex edited #${mine.seq}; it now reads: "Budget is 7k"`, 'two notices: the newest tells it once');

  f.chats.markRead(f.group.id, f.vid.id, notices[1].seq);
  f.chats.edit(mine.id, 'Budget is 8k', 'human');
  assert.equal(f.delta(f.vid.id, notices[1].seq), `· Alex edited #${mine.seq}; it now reads: "Budget is 8k"`, 'read by an agent: the next edit is told again');
  assert.equal(f.delta(f.manager.id, seen), `· Alex edited #${mine.seq}; it now reads: "Budget is 8k"`);
  assert.equal(f.delta(f.vid.id, mine.seq - 1), '[11:00] Alex: Budget is 8k\n[11:00] Mia: Noted.', 'the message among the lines: no notice');

  const solo = f.chats.create({ title: 'Notes', agentIds: [], createdBy: 'human' });
  const note = f.chats.send({ conversationId: solo.id, body: 'todo', authorId: 'human' });
  f.chats.edit(note.id, 'todo: call', 'human');
  assert.equal(f.chats.messages(solo.id).length, 1, 'no agents: no notice');
});

test("the person's deleted message leaves a tombstone at its place and agents are told when it was", () => {
  const f = setup();
  const mine = f.say('Delete the old cuts');
  const answer = f.say('Which ones?', f.vid.id);
  const seen = answer.seq;
  f.chats.markRead(f.group.id, f.vid.id, seen);
  const before = f.events.length;
  f.chats.removeMessage(mine.id, 'human');
  assert.equal(f.chats.message(mine.id), undefined, 'the message itself is gone');
  const [stone] = f.chats.messages(f.group.id).filter((message) => message.meta.status?.details?.tombstone === mine.id);
  assert.ok(stone, 'a tombstone line');
  assert.deepEqual([stone.seq, stone.createdAt, stone.kind, stone.silent, stone.body], [mine.seq, mine.createdAt, 'status', true, 'Message deleted']);
  assert.ok(!JSON.stringify(f.chats.messages(f.group.id)).includes('old cuts'), 'nothing of the text stays, in the tombstone or the notice');
  const order = f.events.slice(before).map((entry) => entry.event).filter((event) => event.startsWith('message.'));
  assert.deepEqual(order.slice(0, 2), ['message.removed', 'message.created'], 'removed, then its tombstone');
  assert.equal(f.delta(f.vid.id, seen), `· Alex deleted their message from 11:00 (#${mine.seq})`, 'named by its time, as agents know messages');
  assert.equal(f.delta(f.manager.id, mine.seq - 1), '· Message deleted\n[11:00] Vic: Which ones?', 'next to its tombstone the notice adds nothing');
  assert.equal(f.chats.search('old cuts').length, 0);

  f.chats.removeMessage(answer.id, 'human');
  assert.equal(f.chats.messages(f.group.id).some((message) => message.meta.status?.details?.tombstone === answer.id), false, "an agent's message deleted by the person leaves no tombstone");
});

test('agents read whom a reply answers, a reply to a deleted message, and never another chat', () => {
  const f = setup();
  const cut = f.say('Rough cut is ready.', f.vid.id);
  const reply = f.say('Make it shorter', 'human', { replyTo: cut.id });
  assert.equal(f.delta(f.vid.id, reply.seq - 1), '[11:00] Alex: (reply to Vic (me): "Rough cut is ready.")\nMake it shorter');
  assert.match(f.delta(f.manager.id, cut.seq - 1), /\[11:00\] Alex: \(reply to Vic: "Rough cut is ready\."\)\nMake it shorter$/, 'also when the quoted message is among the lines');
  f.chats.removeMessage(cut.id, f.vid.id);
  // B-050 K10: an agent's delete of its own line leaves a notice for the other agents (never for itself).
  assert.match(f.delta(f.manager.id, reply.seq - 1), /^\[11:00\] Alex: \(reply to a deleted message\)\nMake it shorter\n· Vic deleted their message from 11:00 \(#\d+\)$/);
  assert.equal(f.delta(f.vid.id, reply.seq - 1), '[11:00] Alex: (reply to a deleted message)\nMake it shorter');

  // B-050 live test (28.10.): a run's own placeholder that is removed while still streaming (an internal or empty
  // answer, a held one) was never posted – no "deleted their message" line for the colleagues.
  const draft = f.chats.beginAgentMessage(f.group.id, f.vid.id, 'run_internal');
  f.chats.removeMessage(draft.id, f.vid.id);
  assert.equal(f.statusLines().filter((line) => line.meta.status?.details?.deleted === draft.id).length, 0, 'no notice for a streaming placeholder');
  assert.equal(f.delta(f.manager.id, reply.seq - 1).includes(`(#${draft.seq})`), false);

  const other = f.chats.create({ title: 'Elsewhere', agentIds: [f.manager.id], createdBy: 'human' });
  const secret = f.chats.send({ conversationId: other.id, body: 'Salary list', authorId: 'human' });
  const forged: Message = { ...reply, id: 'msg_forged', replyTo: secret.id };
  const text = renderMessages(renderContext(f.services, f.manager.id), [forged], { images: false }).lines.join('\n');
  assert.ok(!text.includes('Salary'), text);
});

test('the shared markers: the person changes only own text, notices are for agents, a tombstone marks a gone quote', () => {
  const f = setup();
  const mine = f.say('Draft v1');
  const theirs = f.say('Looks good', f.vid.id);
  assert.equal(personalText(mine), true);
  assert.equal(personalText(theirs), false, "an agent's message");
  assert.equal(personalText({ authorKind: 'human', kind: 'answer' }), false, 'a receipt');
  f.chats.edit(mine.id, 'Draft v2', 'human');
  f.chats.removeMessage(mine.id, 'human');
  const list = f.chats.messages(f.group.id);
  const notices = list.filter(isAgentNotice);
  assert.deepEqual(notices.map((line) => Object.keys(line.meta.status?.details ?? {}).sort()), [['by', 'edited', 'seq'], ['at', 'by', 'deleted', 'seq']], 'B-050 K10: who changed it');
  const stone = list.find((message) => tombstoneOf(message) === mine.id);
  assert.ok(stone && !isAgentNotice(stone), 'the tombstone is shown to the person');
  assert.equal(tombstoneOf(theirs), undefined);

  assert.equal(quotedIn(list, theirs.id, false), list.find((message) => message.id === theirs.id), 'loaded');
  assert.equal(quotedIn(list, mine.id, false), 'deleted', 'its tombstone is loaded: "Deleted message"');
  assert.equal(quotedIn(list.filter((message) => message !== stone), mine.id, false), undefined, 'neither loaded: "Earlier message"');
  assert.equal(quotedIn([], mine.id, true), 'deleted', 'the whole history is loaded and it is not');
});

test('an important reply steered into a running turn keeps its quote and the edit notice before it', { skip: steerWired ? false : 'needs the C6 lines in agents/dispatch-steer.ts (open point)' }, () => {
  const f = setup();
  const mine = f.say('Budget is 5k');
  const cut = f.say('Rough cut is ready.', f.vid.id);
  const started = cut.seq; // Vic's turn read up to here
  f.chats.edit(mine.id, 'Budget is 6k', 'human');
  f.say('Make it shorter', 'human', { replyTo: cut.id, priority: 'important' });
  const input = steerInput(f.services, f.vid.id, f.group.id, started);
  assert.ok(input, 'new lines');
  const lines = input.text.split('\n').slice(1);
  assert.deepEqual(lines, [
    `· Alex edited #${mine.seq}; it now reads: "Budget is 6k"`,
    '[11:00] Alex: (reply to Vic (me): "Rough cut is ready.") (important) Make it shorter',
  ]);
  assert.equal(input.lines, 2);
});
