// Tests for the quiet pickup (src/runtime/chat/quiet-pickup.ts, B-050 K4): which quiet lines an agent
// picks up when it is done – a person's (the owner, a colleague, a bridged contact) above its cursor
// and younger than 14 days; never an agent's, an external agent's, a live-call line, a seen one or one
// of a chat it left – as one 'review' wake per chat under `quiet:<chat>` with the note, at most three
// chats per call (newest first), never twice for the same lines (a failed review turn keeps its cursor);
// in a group only by the agents a normal line would address (lead, reply mode 'all', the replied agent),
// never for a line that @mentions anyone. Round 3: a delayed pickup (an agent with nothing to do) merges a burst
// into one wake, the idle moment makes a waiting one due now, lines read meanwhile withdraw it; which arriving
// lines count (quietPickupLine). Live run A: a colleague's quiet answer to the agent's normal line in a room of two
// agents is the agent's to pick up (quietAnswerPeer) – a quiet line after a quiet one still closes; round 4: within
// seconds (QUIET_ANSWER_DELAY_MS), while a person's quiet lines keep the two-minute bundling.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { MAX_QUIET_CHATS, QUIET_ANSWER_DELAY_MS, QUIET_DELAY_MS, QUIET_NOTE, QUIET_WINDOW_MS, pickUpQuiet, quietAnswerPeer, quietPickupLine, quietWakeKey } from '../../../src/runtime/chat/quiet-pickup.ts';
import { agent, harness } from './harness.ts';

function setup() {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  h.org.add(agent('ag_mara', 'Mara'));
  const chat = (agentIds = ['ag_tom']) => h.chats.create({ agentIds, createdBy: HUMAN_ID });
  const quiet = (conversationId: string, body: string, extra: Record<string, unknown> = {}) =>
    h.chats.send({ conversationId, authorId: HUMAN_ID, body, silent: true, ...extra });
  const pickUp = (agentId = 'ag_tom', delayMs = 0) => pickUpQuiet(h.services, agentId, delayMs);
  const marks = () => h.db.get<{ value: string }>(`SELECT value FROM kv WHERE ns = 'chat.quiet' AND key = 'ag_tom'`)?.value;
  return { ...h, chat, quiet, pickUp, marks };
}

test("a person's quiet line: one review wake for that chat when the agent is done, never twice for the same lines", () => {
  const h = setup();
  const a = h.chat();
  h.quiet(a.id, 'The client prefers blue');
  assert.deepEqual(h.wakeRows(), [], 'delivery wakes nobody');
  assert.deepEqual(h.pickUp(), [a.id]);
  assert.deepEqual(h.wakeRows().map((row) => [row.agent_id, row.reason, row.conversation_id, row.task_id, row.note]), [['ag_tom', 'review', a.id, null, QUIET_NOTE]]);
  assert.equal(h.wakes.cancelKey('ag_tom', quietWakeKey(a.id)), true, 'keyed quiet:<chat>');
  // The review turn failed: the cursor stays where it was.
  assert.deepEqual(h.pickUp(), [], 'not again for the same lines');
  h.clock.advance(1000);
  h.quiet(a.id, 'and the logo bigger');
  assert.deepEqual(h.pickUp(), [a.id], 'a newer quiet line is picked up');
  // The agent read everything (its turn ended well): the mark is dropped.
  h.db.run(`UPDATE members SET read_seq = 100 WHERE conversation_id = ? AND member_id = 'ag_tom'`, [a.id]);
  assert.deepEqual(h.pickUp(), []);
  assert.equal(h.marks(), undefined);
});

test('only quiet lines of people the agent has not seen: never an agent, an external agent, a live-call line, an old line or a chat it left', () => {
  const h = setup();
  const group = h.chat(['ag_tom', 'ag_mara']);
  h.chats.send({ conversationId: group.id, authorId: 'ag_mara', body: 'Checked the cut', silent: true });
  const bot = 'ext:api:0123456789:Research-Bot';
  h.db.run(`INSERT INTO members (conversation_id, member_id, kind, role, read_seq, joined_at) VALUES (?, ?, 'external', 'member', 0, 0)`, [group.id, bot]);
  h.chats.send({ conversationId: group.id, authorId: bot, authorKind: 'external', body: 'Sources attached', silent: true });
  h.quiet(group.id, 'Heard in the call', { meta: { call: { id: 'call_1', participant: 'device:pc', name: 'PC' } } });
  h.chats.send({ conversationId: group.id, authorId: HUMAN_ID, body: 'A normal line wakes by delivery' });
  assert.deepEqual(h.pickUp(), [], 'nothing to pick up');

  const seen = h.chat();
  const line = h.quiet(seen.id, 'Already read');
  h.db.run(`UPDATE members SET read_seq = ? WHERE conversation_id = ? AND member_id = 'ag_tom'`, [line.seq, seen.id]);
  const left = h.chat();
  h.quiet(left.id, 'Too late');
  h.db.run(`UPDATE members SET left_at = 1 WHERE conversation_id = ? AND member_id = 'ag_tom'`, [left.id]);
  assert.deepEqual(h.pickUp(), []);

  const old = h.chat();
  h.quiet(old.id, 'Long ago');
  h.clock.advance(QUIET_WINDOW_MS + 1);
  assert.deepEqual(h.pickUp(), [], 'older than the window');

  const lisa = 'per_lisa0000000';
  h.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, 'Lisa Berg', 'active', 0, 0)`, [lisa]);
  const withLisa = h.chats.create({ agentIds: ['ag_tom'], people: [lisa], createdBy: HUMAN_ID });
  h.chats.send({ conversationId: withLisa.id, authorId: lisa, authorKind: 'human', body: 'FYI the budget moved', silent: true });
  h.clock.advance(1000);
  const bridged = h.chat();
  h.chats.send({ conversationId: bridged.id, authorId: 'ext:tg:42:Ana (Telegram)', authorKind: 'external', body: 'No rush', silent: true });
  assert.deepEqual(h.pickUp(), [bridged.id, withLisa.id], 'a colleague and a bridged contact are people');
});

test('in a group only the agents a normal line would address pick it up: never for a line that mentions anyone, a reply only by its agent', () => {
  const h = setup();
  h.org.add(agent('ag_lin', 'Lin'));
  const lisa = 'per_lisa0000000';
  h.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, 'Lisa Berg', 'active', 0, 0)`, [lisa]);
  const group = h.chats.create({ agentIds: ['ag_tom', 'ag_mara', 'ag_lin'], people: [lisa], createdBy: HUMAN_ID, lead: 'ag_tom' });
  h.chats.update(group.id, { settings: { replyModes: { ag_mara: 'mentions', ag_lin: 'all' } } }, HUMAN_ID);
  const all = () => ['ag_tom', 'ag_mara', 'ag_lin'].map((id) => h.pickUp(id).length);
  const read = () => h.db.run(`UPDATE members SET read_seq = (SELECT last_seq FROM conversations WHERE id = ?) WHERE conversation_id = ?`, [group.id, group.id]);
  h.quiet(group.id, 'For later: the client prefers blue');
  assert.deepEqual(all(), [1, 0, 1], "the lead and the 'all' agent; never a 'mentions' one");
  read();
  h.db.run('DELETE FROM wakes');
  h.quiet(group.id, '@Mara fyi for later');
  assert.deepEqual(h.wakeRows().map((row) => [row.agent_id, row.reason]), [['ag_mara', 'message']], 'the mentioned agent was woken at once');
  assert.deepEqual(all(), [0, 0, 0], 'so nobody picks it up – and nobody else for a line addressed to Mara');
  h.chats.send({ conversationId: group.id, authorId: lisa, authorKind: 'human', body: 'Note for you', mentions: [HUMAN_ID], silent: true });
  assert.deepEqual(all(), [0, 0, 0], "a colleague's line to the owner is not the agents' (K3)");
  read();
  const ask = h.chats.send({ conversationId: group.id, authorId: 'ag_mara', body: 'Which color?' });
  read();
  h.chats.send({ conversationId: group.id, authorId: HUMAN_ID, kind: 'answer', body: 'Blue', silent: true, replyTo: ask.id });
  assert.deepEqual(all(), [0, 1, 0], 'a reply to Mara\'s line is hers, whatever her reply mode');
});

test('at most three chats per idle moment, the newest first; the rest at the next one', () => {
  const h = setup();
  const chats = [h.chat(), h.chat(), h.chat(), h.chat()];
  for (const [index, chat] of chats.entries()) { h.quiet(chat.id, `note ${index}`); h.clock.advance(1000); }
  assert.equal(MAX_QUIET_CHATS, 3);
  assert.deepEqual(h.pickUp(), [chats[3].id, chats[2].id, chats[1].id]);
  assert.deepEqual(h.pickUp(), [chats[0].id]);
  assert.deepEqual(h.pickUp(), []);
  assert.deepEqual(h.pickUp('ag_mara'), [], 'only chats the agent is in');
});

test('round 3: a delayed pickup is due later and merges a burst; the idle moment makes a waiting one due now; lines read meanwhile withdraw it', () => {
  const h = setup();
  const a = h.chat();
  const due = () => h.wakeRows().map((row) => [row.reason, row.conversation_id, row.note, row.due_at - h.clock.now()]);
  h.quiet(a.id, 'For later');
  assert.deepEqual(h.pickUp('ag_tom', QUIET_DELAY_MS), [a.id]);
  assert.deepEqual(due(), [['review', a.id, QUIET_NOTE, QUIET_DELAY_MS]]);
  h.clock.advance(30_000);
  h.quiet(a.id, 'and this too');
  assert.deepEqual(h.pickUp('ag_tom', QUIET_DELAY_MS), [a.id], 'the newer line');
  assert.deepEqual(due(), [['review', a.id, QUIET_NOTE, QUIET_DELAY_MS - 30_000]], 'one wake for the burst: the earliest due time');
  assert.deepEqual(h.pickUp('ag_tom', QUIET_DELAY_MS), [], 'nothing new');
  assert.deepEqual(h.pickUp(), [a.id], 'the agent is done: the waiting pickup is due now');
  assert.deepEqual(due(), [['review', a.id, QUIET_NOTE, 0]]);

  const b = h.chat();
  h.quiet(b.id, 'Another note');
  h.pickUp('ag_tom', QUIET_DELAY_MS);
  h.db.run(`UPDATE members SET read_seq = 100 WHERE conversation_id = ? AND member_id = 'ag_tom'`, [b.id]); // another turn read it
  assert.deepEqual(h.pickUp('ag_tom', QUIET_DELAY_MS), []);
  assert.deepEqual(due().map((row) => row[1]), [a.id], 'the waiting pickup of the read lines is withdrawn');
});

test("live run A: in a room of two agents a colleague's quiet answer to the agent's normal line is its to pick up – not one after a quiet line, one that mentions, one in a larger room, nor by its author", () => {
  const h = setup();
  const room = h.chats.create({ agentIds: ['ag_tom', 'ag_mara'], humans: false, createdBy: 'ag_tom' });
  const post = (authorId: string, body: string, extra: Record<string, unknown> = {}) => h.chats.send({ conversationId: room.id, authorId, authorKind: 'agent', body, ...extra });
  const ask = post('ag_tom', 'My shortlist: Notelo, Jotnest. What would you suggest?');
  assert.deepEqual(h.wakeRows().map((row) => row.agent_id), ['ag_mara'], 'K3: his normal line wakes her');
  h.db.run('DELETE FROM wakes');
  const vote = post('ag_mara', 'My vote is Notelo – let us choose it.', { silent: true });
  assert.deepEqual(h.wakeRows(), [], 'the quiet answer wakes nobody now');
  assert.equal(quietAnswerPeer(h.chats, vote), 'ag_tom', 'delivery tells the dispatcher: the asker picks it up when free');
  assert.equal(quietAnswerPeer(h.chats, ask), undefined, 'a normal line is delivered as usual');
  assert.deepEqual(h.pickUp('ag_mara'), [], 'never by its author');
  assert.deepEqual(h.pickUp(), [room.id], 'the asker – before, it never learned the answer');
  assert.deepEqual(h.wakeRows().map((row) => [row.agent_id, row.reason, row.note]), [['ag_tom', 'review', QUIET_NOTE]]);
  assert.deepEqual(h.pickUp(), [], 'once');

  // [[silent]] still closes: a quiet line after a quiet one, or one that mentions (it woke at once), is nobody's to pick up.
  const closing = post('ag_tom', 'Notelo it is.', { silent: true });
  assert.equal(quietAnswerPeer(h.chats, closing), undefined);
  assert.deepEqual(h.pickUp('ag_mara'), []);
  post('ag_tom', 'And a tagline?');
  const mentioned = post('ag_mara', '@Tom Quick to capture.', { silent: true, mentions: ['ag_tom'] });
  assert.equal(quietAnswerPeer(h.chats, mentioned), undefined);

  // A larger room, or a room of an agent and the person: no pickup of an agent's line.
  const group = h.chats.create({ agentIds: ['ag_tom', 'ag_mara'], createdBy: HUMAN_ID });
  h.chats.send({ conversationId: group.id, authorId: 'ag_tom', authorKind: 'agent', body: 'Mara, your pick?' });
  const inGroup = h.chats.send({ conversationId: group.id, authorId: 'ag_mara', authorKind: 'agent', body: 'Notelo', silent: true });
  assert.equal(quietAnswerPeer(h.chats, inGroup), undefined);
  const withOwner = h.chats.create({ agentIds: ['ag_tom'], createdBy: HUMAN_ID });
  h.chats.send({ conversationId: withOwner.id, authorId: HUMAN_ID, body: 'Which one?' });
  const toOwner = h.chats.send({ conversationId: withOwner.id, authorId: 'ag_tom', authorKind: 'agent', body: 'Notelo', silent: true });
  assert.equal(quietAnswerPeer(h.chats, toOwner), undefined);
  h.db.run('DELETE FROM wakes');
  assert.deepEqual([h.pickUp(), h.pickUp('ag_mara')], [[], []]);
});

test("round 4: a delayed pickup of a colleague's quiet answer is due within seconds – a person's quiet line keeps QUIET_DELAY_MS", () => {
  const h = setup();
  const due = () => h.wakeRows().map((row) => [row.conversation_id, row.due_at - h.clock.now()]);
  const room = h.chats.create({ agentIds: ['ag_tom', 'ag_mara'], humans: false, createdBy: 'ag_tom' });
  h.chats.send({ conversationId: room.id, authorId: 'ag_tom', authorKind: 'agent', body: 'Notelo or Jotnest?' });
  h.db.run('DELETE FROM wakes');
  h.chats.send({ conversationId: room.id, authorId: 'ag_mara', authorKind: 'agent', body: 'Notelo.', silent: true });
  assert.ok(QUIET_ANSWER_DELAY_MS > 0 && QUIET_ANSWER_DELAY_MS <= 5_000, 'a few seconds');
  assert.deepEqual(h.pickUp('ag_tom', QUIET_DELAY_MS), [room.id]);
  assert.deepEqual(due(), [[room.id, QUIET_ANSWER_DELAY_MS]], 'live run A3: 2 of 2:34 min were this wait');
  const solo = h.chat();
  h.clock.advance(1000);
  h.quiet(solo.id, 'For later: the client prefers blue');
  assert.deepEqual(h.pickUp('ag_tom', QUIET_DELAY_MS), [solo.id], 'the answer is not picked up twice');
  assert.deepEqual(due(), [[room.id, QUIET_ANSWER_DELAY_MS - 1000], [solo.id, QUIET_DELAY_MS]], "a person's quiet lines still bundle for two minutes");
  assert.deepEqual(h.pickUp(), [solo.id, room.id], 'the agent is done: both are due now (newest first)');
});

test('round 3: quietPickupLine – only a person\'s final quiet text or answer that mentions nobody and is no call line', () => {
  const line = { silent: true, state: 'final', kind: 'text', authorKind: 'human', authorId: HUMAN_ID, mentions: [] as string[], meta: {} } as const;
  assert.equal(quietPickupLine(line), true);
  assert.equal(quietPickupLine({ ...line, kind: 'answer' }), true, 'an answer receipt');
  assert.equal(quietPickupLine({ ...line, authorKind: 'external', authorId: 'ext:tg:42:Ana (Telegram)' }), true, 'a bridged contact');
  assert.equal(quietPickupLine({ ...line, mentions: [HUMAN_ID] }), true, 'mentioning only oneself');
  assert.equal(quietPickupLine({ ...line, silent: false }), false, 'a normal line wakes by delivery');
  assert.equal(quietPickupLine({ ...line, mentions: ['ag_tom'] }), false, 'a mentioned agent was woken at once');
  assert.equal(quietPickupLine({ ...line, authorKind: 'agent', authorId: 'ag_mara' }), false);
  assert.equal(quietPickupLine({ ...line, authorKind: 'external', authorId: 'ext:api:0123456789:Research-Bot' }), false, 'an external agent');
  assert.equal(quietPickupLine({ ...line, meta: { call: { id: 'call_1', participant: 'device:pc', name: 'PC' } } }), false, 'a live-call line');
  assert.equal(quietPickupLine({ ...line, state: 'streaming' }), false);
  assert.equal(quietPickupLine({ ...line, kind: 'status' }), false);
});
