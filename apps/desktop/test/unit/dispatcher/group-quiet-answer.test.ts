// B-050 live round 5 (scenario F, a work group of three without the person): the manager asked "@Mira" and "@Jonas"
// in one turn; in a room with colleagues a colleague's final text is quiet by default, and Mira's answer named nobody
// with @ – it woke nobody and no rule picked it up (round 3's pickup of a quiet answer held only in a room of two).
// Only Jonas's "@Manager" brought the manager back; had he answered like Mira, the group would have stood still and
// the person would never have got the result. Owner: "kein Unterschied, ob der CEO da dabei ist oder nicht. Das ist
// halt einfach wie wenn eine KI dabei ist oder nicht." Now the asker picks up a quiet answer to its @question in any
// room (chat/quiet-pickup.ts quietAnswerPeer) – once the colleagues still answering in that chat are done
// (agents/dispatch-groups.ts waitsFor), so both answers cost the asker one turn, not one each.
// With the real dispatcher, delivery, wake queue and scheduler; a fake executor stands in for the turns.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUIET_NOTE, pickUpQuiet, quietAnswerPeer } from '../../../src/runtime/chat/quiet-pickup.ts';
import { agent } from '../chat/harness.ts';
import { flush, openWakes, setup } from './fakes.ts';

/** "A few seconds" (QUIET_ANSWER_DELAY_MS), spelled out so this also runs against the code before round 5. */
const FEW_SECONDS = 5_000;

function scene() {
  const h = setup({ maxConcurrent: 3 });
  h.org.add(agent('ag_mgr', 'Manager', { mode: 'manager' }));
  h.org.add(agent('ag_mira', 'Mira', { managerId: 'ag_mgr' }));
  h.org.add(agent('ag_tom', 'Tom', { managerId: 'ag_mgr' }));
  const room = h.chats.create({ title: 'Tagline', agentIds: ['ag_mgr', 'ag_mira', 'ag_tom'], humans: false, createdBy: 'ag_mgr', lead: 'ag_mgr' });
  const turnsOf = (agentId: string) => h.executor.calls.filter((item) => item.request.agentId === agentId && item.request.conversationId === room.id);
  const post = (authorId: string, body: string, extra: Record<string, unknown> = {}) => h.chats.send({ conversationId: room.id, authorId, authorKind: 'agent', body, ...extra });
  return { ...h, room, turnsOf, post };
}

test('live round 5: in a group the asker picks up a quiet answer to its @question – not a closing note, a line after the answer, one that mentions, nor one asked by someone else', () => {
  const h = scene();
  const ask = h.post('ag_mgr', '@Mira @Tom Notelo or Jotnest – your picks?');
  assert.deepEqual(ask.mentions.slice().sort(), ['ag_mira', 'ag_tom']);
  h.db.run('DELETE FROM wakes');
  const mira = h.post('ag_mira', 'Notelo – short and clear.', { silent: true });
  assert.deepEqual(h.wakeRows(), [], 'the quiet answer wakes nobody now');
  assert.equal(quietAnswerPeer(h.chats, mira), 'ag_mgr', 'delivery tells the dispatcher: the asker picks it up when free');
  const tom = h.post('ag_tom', 'Notelo for me too.', { silent: true });
  assert.equal(quietAnswerPeer(h.chats, tom), 'ag_mgr', 'Tom was asked in the same line');
  assert.deepEqual([pickUpQuiet(h.services, 'ag_tom'), pickUpQuiet(h.services, 'ag_mira')], [[], []], 'never by a colleague who was not the asker');
  assert.deepEqual(pickUpQuiet(h.services, 'ag_mgr'), [h.room.id], 'the asker – before, it never learned the answers');
  assert.deepEqual(h.wakeRows().map((row) => [row.agent_id, row.reason, row.note]), [['ag_mgr', 'review', QUIET_NOTE]]);
  assert.deepEqual(pickUpQuiet(h.services, 'ag_mgr'), [], 'once');

  // [[silent]] still closes: the manager's closing note answers nobody's question, Mira's second line follows her answer.
  const closing = h.post('ag_mgr', 'Notelo it is – I will tell Alex.', { silent: true });
  assert.equal(quietAnswerPeer(h.chats, closing), undefined, 'nobody @asked the manager');
  const again = h.post('ag_mira', 'Thanks, all.', { silent: true });
  assert.equal(quietAnswerPeer(h.chats, again), undefined, 'she answered already');
  // An answer that @mentions woke at once; a quiet @question asks nobody to answer; the newest asker gets it.
  h.post('ag_mgr', '@Mira and a tagline?');
  const mentioned = h.post('ag_mira', '@Manager A place for your thoughts.', { silent: true });
  assert.equal(quietAnswerPeer(h.chats, mentioned), undefined);
  h.post('ag_mgr', '@Tom one more idea?', { silent: true });
  const quietAsked = h.post('ag_tom', 'Jot it, keep it.', { silent: true });
  assert.equal(quietAnswerPeer(h.chats, quietAsked), undefined, 'a quiet @question: nobody waits for the answer');
  h.post('ag_mgr', '@Tom which of the two?');
  h.post('ag_mira', '@Tom please keep it short.');
  const newest = h.post('ag_tom', 'The first.', { silent: true });
  assert.equal(quietAnswerPeer(h.chats, newest), 'ag_mira', 'the newest @question is the one answered');
  h.db.run('DELETE FROM wakes');
  h.db.run(`DELETE FROM kv WHERE ns = 'chat.quiet'`);
  assert.deepEqual([pickUpQuiet(h.services, 'ag_mira'), pickUpQuiet(h.services, 'ag_mgr')], [[h.room.id], [h.room.id]], 'Mira for Tom\'s answer; the manager still for the two votes it has not seen');
});

test('live round 5: both colleagues answer the manager\'s @question quietly without @ – the manager picks both up in one turn after the second one is done', async () => {
  const h = scene();
  h.dispatcher.start();
  h.post('ag_mgr', '@Mira @Tom Notelo or Jotnest – your picks?');
  await flush();
  const [mira] = h.turnsOf('ag_mira');
  const [tom] = h.turnsOf('ag_tom');
  assert.ok(mira && tom, 'both colleagues answer');
  // Like the turn executor: each turn's final text is written into the chat while it runs.
  const miraDraft = h.chats.beginAgentMessage(h.room.id, 'ag_mira', mira.request.runId);
  const tomDraft = h.chats.beginAgentMessage(h.room.id, 'ag_tom', tom.request.runId);
  await flush();
  h.clock.advance(20_000);
  h.chats.finishAgentMessage(miraDraft.id, { body: 'Notelo – short and clear.', state: 'final', silent: true });
  mira.finish();
  await flush();
  h.clock.advance(FEW_SECONDS);
  h.scheduler.tick();
  await flush();
  assert.equal(h.turnsOf('ag_mgr').length, 0, 'Tom still answers in this chat: the pickup waits for him');
  h.clock.advance(15_000);
  h.chats.finishAgentMessage(tomDraft.id, { body: 'Notelo for me too.', state: 'final', silent: true });
  tom.finish();
  await flush();
  h.clock.advance(FEW_SECONDS);
  h.scheduler.tick();
  await flush();
  const back = h.turnsOf('ag_mgr');
  assert.equal(back.length, 1, 'the manager learns both answers – before, nothing woke it and the group stood still');
  assert.deepEqual([back[0].request.reason, back[0].request.notes.map((note) => note.text)], ['review', [QUIET_NOTE]]);
  back[0].finish();
  await flush();
  h.clock.advance(2 * 60_000);
  h.scheduler.tick();
  await flush();
  assert.deepEqual([h.turnsOf('ag_mgr').length, h.turnsOf('ag_mira').length, h.turnsOf('ag_tom').length], [1, 1, 1], 'once – and the answers wake no colleague');
  assert.deepEqual(openWakes(h.db), []);
  await h.dispatcher.stop();
});
