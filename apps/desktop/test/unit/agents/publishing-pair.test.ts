// B-050 K3 – a room of two with an agent (agents/publishing.ts pairPeer, defaultVisibility, publishLine;
// turn-finish.ts): a message turn's untagged answer to the other agent posts at normal level and wakes it
// (chat/delivery.ts, the loop guard still caps it), [[silent]] is the closing note that wakes nobody; a
// 1:1 with the person or a room of three keeps the quiet default for an agent-to-agent message turn. Round 5: where
// colleagues are members, the publishing line says an @mention wakes them even in a [[silent]] closing note.
// Owns: these assertions only. Never: real engines, accounts, timers or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { defaultVisibility, pairPeer, publishLine, publishNote } from '../../../src/runtime/agents/publishing.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import type { MemberKind } from '../../../src/shared/model/chat.ts';
import { agent } from '../chat/harness.ts';
import { setup } from './fixture.ts';

test('pairPeer: the other agent or external agent of a room of exactly two active members', () => {
  const m = (memberId: string, kind: MemberKind, leftAt?: number) => ({ memberId, kind, ...(leftAt ? { leftAt } : {}) });
  assert.equal(pairPeer([m('ag_tom', 'agent'), m('ag_mia', 'agent')], 'ag_tom'), 'ag_mia');
  assert.equal(pairPeer([m('ag_tom', 'agent'), m('ext:api:0123456789:Bot', 'external')], 'ag_tom'), 'ext:api:0123456789:Bot');
  assert.equal(pairPeer([m('ag_tom', 'agent'), m('human', 'human')], 'ag_tom'), undefined, 'a 1:1 with the person');
  assert.equal(pairPeer([m('ag_tom', 'agent'), m('ag_mia', 'agent'), m('human', 'human')], 'ag_tom'), undefined, 'three members');
  assert.equal(pairPeer([m('ag_tom', 'agent'), m('ag_mia', 'agent'), m('ag_lin', 'agent', 5)], 'ag_tom'), 'ag_mia', 'one who left does not count');
  assert.equal(pairPeer([m('ag_mia', 'agent'), m('ag_lin', 'agent')], 'ag_tom'), undefined, 'not its room');
});

test('defaultVisibility and publishLine: a message turn in an agent pair posts at normal level and says how to close', () => {
  const base = { awaited: false, mustSee: false, reason: 'message' as const };
  assert.equal(defaultVisibility({ ...base, pairAgent: true }), 'notify');
  assert.equal(defaultVisibility(base), 'silent', 'elsewhere an agent-to-agent message turn stays quiet');
  assert.equal(defaultVisibility({ ...base, reason: 'review', pairAgent: true }), 'internal', 'only a message turn');
  const line = publishLine({ visibility: 'notify', call: false, inChat: true, owner: 'Gerd', peer: 'Mia' });
  assert.match(line, /reaches Mia/);
  assert.match(line, /\[\[silent\]\] when I need nothing more from them/);
  assert.doesNotMatch(line, /Gerd/, 'the owner is not in the room');
  assert.match(publishLine({ visibility: 'notify', call: false, inChat: true, owner: 'Gerd', who: 'Gerd', peer: 'Mia' }), /notifies Gerd/, 'a waiting person wins');
});

test("in an agent pair the untagged answer wakes the asking agent; a [[silent]] closing note wakes nobody", async () => {
  const h = setup();
  Object.assign(h.services, { runs: new Journal({ db: h.db, bus: h.bus, clock: h.clock }), router: { route: async () => h.route } });
  Object.assign(h.services.accounts, { list: () => [], markUnavailable: () => false, markLimited: () => {} });
  Object.assign(h.services.catalog, { list: () => [] });
  h.org.add(agent('ag_mia', 'Mia'));
  const room = h.chats.create({ agentIds: ['ag_mia', h.tom.id], humans: false, createdBy: 'ag_mia' });
  let count = 0;
  const turn = () => {
    h.wakes.done(h.wakes.claim(h.tom.id, Number.MAX_SAFE_INTEGER).map((wake) => wake.id));
    return new TurnExecutor(() => h.services).execute(h.request({ runId: `run_${++count}`, conversationId: room.id, reason: 'message' }));
  };
  const miaWakes = () => h.wakeRows().filter((row) => row.agent_id === 'ag_mia').length;

  h.chats.send({ conversationId: room.id, authorId: 'ag_mia', body: 'Can you check the numbers in the sheet?' });
  h.state.script = async () => ({ text: 'Checked: row 12 was wrong, I fixed it.', stop: 'done' });
  const answer = await turn();
  assert.equal(h.chats.message(answer.messageId!)!.silent, false);
  assert.equal(miaWakes(), 1, 'Mia hears the answer (K3: the other member of a room of two)');

  h.db.run(`DELETE FROM wakes WHERE agent_id = 'ag_mia'`);
  h.chats.send({ conversationId: room.id, authorId: 'ag_mia', body: 'Thanks!' });
  h.state.script = async () => ({ text: 'You are welcome. [[silent]]', stop: 'done' });
  const closing = await turn();
  assert.equal(h.chats.message(closing.messageId!)!.silent, true);
  assert.equal(miaWakes(), 0, 'the closing note wakes nobody');
});

test('round 5 (live F: quiet @mention closing notes woke colleagues for nothing): where colleagues are, the line says a closing note names nobody with @', () => {
  const closing = /\. An @mention wakes that colleague even in a \[\[silent\]\] note, so my closing note names nobody with @\.$/;
  assert.match(publishLine({ visibility: 'notify', call: false, inChat: true, owner: 'Gerd', peer: 'Mia' }), closing, 'a room of two agents');
  for (const visibility of ['notify', 'silent', 'internal'] as const) {
    assert.match(publishLine({ visibility, call: false, inChat: true, owner: 'Gerd', colleagues: true }), closing, `a group: ${visibility}`);
    assert.doesNotMatch(publishLine({ visibility, call: false, inChat: true, owner: 'Gerd' }), /@mention/, `no colleague: ${visibility}`);
  }
  assert.doesNotMatch(publishLine({ visibility: 'notify', call: true, inChat: true, owner: 'Gerd', colleagues: true }), /@mention/, 'a call speaks its answer');
  const m = (memberId: string, kind: MemberKind, leftAt?: number) => ({ memberId, kind, ...(leftAt ? { leftAt } : {}) });
  const services = (members: ReturnType<typeof m>[]) => ({
    chats: { members: () => members }, settings: { get: () => ({ profile: { name: 'Gerd' } }) }, org: { get: () => ({ name: 'Mia' }) },
  }) as never;
  const plan = { agent: { id: 'ag_tom' }, conversationId: 'cnv_1', publish: 'silent' } as never;
  assert.match(publishNote(services([m('ag_tom', 'agent'), m('ag_mia', 'agent'), m('human', 'human')]), plan), closing, 'a group with the person');
  assert.doesNotMatch(publishNote(services([m('ag_tom', 'agent'), m('human', 'human'), m('ag_lin', 'agent', 5)]), plan), /@mention/, 'a colleague who left is none');
});
