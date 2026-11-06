// B-050 round 4 with the real dispatcher, delivery, wake queue and scheduler (a fake executor stands in for the turns, a
// fake decision model for the responder pick). Owner: "kein Unterschied, ob der CEO da dabei ist oder nicht. Das ist
// halt einfach wie wenn eine KI dabei ist oder nicht." – in an AI work group of three a line that @mentions nobody
// reaches the colleague the pick names after the sender's turn, and "nobody needs to reply" ends the exchange; a
// three-agent discussion ends in the loop guard instead of running on, also when every line names everyone it may.
// Live round 3 (A3): a colleague's quiet answer reaches the free asker within seconds, not after two minutes. chat.send
// says when a pick decides. Round 5: a quiet answer sent mid-turn is picked up after that turn (dispatch-groups.ts
// waitsFor), and every chat.send note says a closing note names nobody with @.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DecisionRequest, DecisionService, RuntimeServices } from '../../../src/runtime/contracts.ts';
import { QUIET_NOTE } from '../../../src/runtime/chat/quiet-pickup.ts';
import { chatTools } from '../../../src/runtime/tools/builtin/chat.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import { agent } from '../chat/harness.ts';
import { flush, openWakes, setup, type FakeCall } from './fakes.ts';

/** chat/responders.ts NOBODY and "a few seconds", spelled out so these tests also run against the code before round 4. */
const NOBODY = 'Nobody needs to reply';
const FEW_SECONDS = 5_000;

/** Manager (lead), Mira and Tom in a work group without the person; `pick` answers the responder question. */
function scene(pick?: (request: DecisionRequest) => string) {
  const h = setup();
  const asked: DecisionRequest[] = [];
  if (pick) {
    h.services.decisions = {
      available: () => true,
      decide: async (request) => { asked.push(request); return { choice: pick(request), confidence: 0.9, by: 'fake' }; },
    } satisfies DecisionService;
  }
  h.org.add(agent('ag_mgr', 'Manager', { mode: 'manager' }));
  h.org.add(agent('ag_mira', 'Mira', { managerId: 'ag_mgr' }));
  h.org.add(agent('ag_tom', 'Tom', { managerId: 'ag_mgr' }));
  const room = h.chats.create({ title: 'Naming', agentIds: ['ag_mgr', 'ag_mira', 'ag_tom'], humans: false, createdBy: 'ag_mgr', lead: 'ag_mgr' });
  const turnsOf = (agentId: string) => h.executor.calls.filter((item) => item.request.agentId === agentId && item.request.conversationId === room.id);
  /** A line of a running turn (chat.send), or of no turn. */
  const say = (from: string | FakeCall, body: string) => h.chats.send(typeof from === 'string'
    ? { conversationId: room.id, authorId: from, authorKind: 'agent', body }
    : { conversationId: room.id, authorId: from.request.agentId, authorKind: 'agent', body, runId: from.request.runId });
  return { ...h, asked, room, turnsOf, say };
}

test('round 4: in a work group of three a line that @mentions nobody reaches the colleague the pick names – after the sender\'s turn; "nobody" ends it', async () => {
  const script = ['Mira', 'Manager', NOBODY];
  const h = scene(() => script.shift() ?? NOBODY);
  h.dispatcher.start();
  const direct = h.chats.create({ agentIds: ['ag_mgr'], createdBy: 'human' });
  h.chats.send({ conversationId: direct.id, body: 'Find a name for our note app with Mira and Tom.', authorId: 'human' });
  await flush();
  const manager = h.executor.last();
  h.say(manager, 'Shortlist: Notelo, Jotnest. Which one fits a note app?');
  await flush();
  assert.deepEqual(h.asked[0]?.options, ['Mira', 'Tom', NOBODY], 'the same pick as for a person – the author is no option');
  assert.equal(h.turnsOf('ag_mira').length, 0, 'she answers after the turn that wrote to her');
  manager.finish();
  await flush();
  const [mira] = h.turnsOf('ag_mira');
  assert.ok(mira, 'Mira is woken without an @mention – before, nothing woke anyone');
  assert.deepEqual([mira.request.reason, h.turnsOf('ag_tom').length], ['message', 0], 'only the picked colleague, not everyone');
  h.say(mira, 'Notelo – short and clear.');
  mira.finish();
  await flush();
  const back = h.turnsOf('ag_mgr');
  assert.equal(back.length, 1, 'her answer reaches the manager through the pick');
  h.say(back[0], 'Notelo it is. Thanks!');
  back[0].finish();
  await flush();
  assert.deepEqual([h.turnsOf('ag_mgr').length, h.turnsOf('ag_mira').length, h.turnsOf('ag_tom').length], [1, 1, 0], 'nobody needs to reply to the closing line');
  assert.deepEqual(openWakes(h.db), []);
  await h.dispatcher.stop();
});

test('round 4: chat.send says a pick decides when one will – and still names whom a mention woke', async () => {
  const h = scene(() => 'Mira');
  const send = chatTools.find((tool) => tool.name === 'chat.send')!;
  const ctx = { agent: h.org.get('ag_mgr')!, runId: 'run_mgr', conversationId: h.room.id, mode: 'general', services: h.services as RuntimeServices, signal: new AbortController().signal, status: () => {} } as ToolContext;
  const run = async (args: Record<string, unknown>) => JSON.parse(((await send.run(args as never, ctx)) as ToolOutput).content.map((part) => (part as { text?: string }).text ?? '').join(''));
  const open = await run({ chatId: h.room.id, text: 'Which name fits best?' });
  assert.deepEqual(open.woken, []);
  assert.match(open.note, /^No colleague is woken yet: a pick decides who should answer this line, or that nobody needs to – a reply comes to me as a new turn .*I @mention a colleague whose answer I need\.$/);
  assert.match(open.note, /\. An @mention wakes that colleague even in a quiet line \(level "silent"\) or a \[\[silent\]\] note, so my closing note names nobody with @\. I @mention/, 'round 5');
  await flush();
  assert.deepEqual(openWakes(h.db).map((wake) => wake.agent_id), ['ag_mira'], 'then the pick woke Mira');
  const named = await run({ chatId: h.room.id, text: 'Tom, yours?', mentions: ['ag_tom'] });
  assert.deepEqual(named.woken, ['Mira', 'Tom'], 'Mira for the line before, Tom for this one');
  assert.match(named.note, /^Mira and Tom answer after this turn of mine/);
});

/** Runs every open turn: each posts one line (`line` decides it) and ends; 10 s per line. Stops when nothing runs or after `max` lines. */
async function discuss(h: ReturnType<typeof scene>, line: (call: FakeCall, n: number) => string, max = 60): Promise<{ lines: number; ended: boolean }> {
  let lines = 0;
  for (;;) {
    const open = h.executor.calls.filter((call) => !call.done);
    if (!open.length) return { lines, ended: true };
    for (const call of open) {
      if (lines >= max) return { lines, ended: false };
      h.clock.advance(10_000);
      if (call.request.conversationId === h.room.id) { h.say(call, line(call, ++lines)); await flush(); }
      call.finish();
      await flush();
    }
  }
}

test('round 4: a three-agent discussion ends – even when every line names everyone it may, never more than two are woken per line', async () => {
  const h = scene((request) => (request.options ?? []).filter((option) => option !== NOBODY).join(', '));
  h.dispatcher.start();
  h.say('ag_mgr', 'Ideas for the app name, anyone?');
  await flush();
  assert.equal(h.turnsOf('ag_mira').length + h.turnsOf('ag_tom').length, 2, 'the pick named both colleagues');
  const { lines, ended } = await discuss(h, (call, n) => `${call.request.agentId}: idea ${n}`);
  assert.ok(ended, `the discussion ended (${lines} lines)`);
  assert.ok(lines >= 10, `it was a discussion (${lines} lines)`);
  const all = h.chats.messages(h.room.id, { limit: 200 });
  const pause = all.findIndex((message) => message.kind === 'status' && message.body === 'Agent replies paused: back-and-forth without progress');
  assert.ok(pause > 0, 'the loop guard stopped it');
  const before = all.slice(0, pause).filter((message) => message.kind === 'text').map((message) => message.authorId);
  assert.equal(before.filter((author, i) => i > 0 && author !== before[i - 1]).length, 12, 'at the twelfth change of speaker');
  const after = all.slice(pause + 1).filter((message) => message.kind === 'text').map((message) => message.authorId);
  // At most the other running turn (two run at a time here) and the one coalesced wake per agent woken before the pause.
  assert.ok(after.length <= 4, `afterwards only the turns already under way (${after.join(', ')})`);
  assert.ok(h.asked.every((request) => !request.options?.includes(request.context?.match(/^From (\w+)/)?.[1] ?? '')), 'never the author');
  assert.deepEqual(openWakes(h.db), []);
  await h.dispatcher.stop();
});

test('round 4: three agents passing the word in a circle with @mentions stop too – before, only the rate limit could', async () => {
  const h = scene();
  const next: Record<string, string> = { ag_mgr: 'Mira', ag_mira: 'Tom', ag_tom: 'Manager' };
  h.dispatcher.start();
  h.say('ag_mgr', '@Mira your idea?');
  await flush();
  const { lines, ended } = await discuss(h, (call, n) => `@${next[call.request.agentId]} idea ${n}, yours?`, 40);
  assert.ok(ended, `the circle ended (${lines} lines)`);
  assert.ok(lines <= 13, `after twelve changes of speaker (${lines} lines)`);
  assert.deepEqual(openWakes(h.db), []);
  await h.dispatcher.stop();
});

test("round 4 (live run A3): a colleague's quiet answer reaches the free asker within seconds, once", async () => {
  const h = setup();
  h.org.add(agent('ag_mgr', 'Manager', { mode: 'manager' }));
  h.org.add(agent('ag_mira', 'Mira', { managerId: 'ag_mgr' }));
  const room = h.chats.create({ title: 'Naming', agentIds: ['ag_mgr', 'ag_mira'], humans: false, createdBy: 'ag_mgr', lead: 'ag_mgr' });
  const turnsOf = (agentId: string) => h.executor.calls.filter((item) => item.request.agentId === agentId);
  h.dispatcher.start();
  h.chats.send({ conversationId: room.id, authorId: 'ag_mgr', authorKind: 'agent', body: 'Notelo or Jotnest – your pick?' });
  await flush();
  const [mira] = turnsOf('ag_mira');
  h.chats.send({ conversationId: room.id, authorId: 'ag_mira', authorKind: 'agent', body: 'Notelo.', silent: true, runId: mira.request.runId });
  mira.finish();
  await flush();
  assert.equal(turnsOf('ag_mgr').length, 0, 'a quiet answer wakes nobody at once');
  h.clock.advance(FEW_SECONDS);
  h.scheduler.tick();
  await flush();
  const back = turnsOf('ag_mgr');
  assert.equal(back.length, 1, 'picked up within seconds – before, after QUIET_DELAY_MS (2 of the 2:34 min of run A3)');
  assert.deepEqual([back[0].request.conversationId, back[0].request.reason, back[0].request.notes.map((note) => note.text)], [room.id, 'review', [QUIET_NOTE]]);
  back[0].finish();
  await flush();
  h.clock.advance(2 * 60_000);
  h.scheduler.tick();
  await flush();
  assert.equal(turnsOf('ag_mgr').length, 1, 'once');
  assert.deepEqual(openWakes(h.db), []);
  await h.dispatcher.stop();
});

test("round 5: a colleague's quiet answer sent mid-turn is picked up once her turn ended – the asker answers once, not before", async () => {
  const h = setup();
  h.org.add(agent('ag_mgr', 'Manager', { mode: 'manager' }));
  h.org.add(agent('ag_mira', 'Mira', { managerId: 'ag_mgr' }));
  const room = h.chats.create({ title: 'Naming', agentIds: ['ag_mgr', 'ag_mira'], humans: false, createdBy: 'ag_mgr', lead: 'ag_mgr' });
  const turnsOf = (agentId: string) => h.executor.calls.filter((item) => item.request.agentId === agentId);
  h.dispatcher.start();
  h.chats.send({ conversationId: room.id, authorId: 'ag_mgr', authorKind: 'agent', body: 'Notelo or Jotnest – your pick?' });
  await flush();
  const [mira] = turnsOf('ag_mira');
  // Her quiet answer by chat.send while her turn still runs (a [[silent]] final would end the turn at once).
  h.chats.send({ conversationId: room.id, authorId: 'ag_mira', authorKind: 'agent', body: 'Notelo.', silent: true, runId: mira.request.runId });
  await flush();
  h.clock.advance(FEW_SECONDS);
  h.scheduler.tick();
  await flush();
  assert.equal(turnsOf('ag_mgr').length, 0, 'her turn still runs: the pickup waits for it – before, the manager started now');
  h.chats.send({ conversationId: room.id, authorId: 'ag_mira', authorKind: 'agent', body: 'Jotnest reads like a bird.', silent: true, runId: mira.request.runId });
  mira.finish();
  await flush();
  const back = turnsOf('ag_mgr');
  assert.equal(back.length, 1, 'picked up right after her turn ended');
  assert.deepEqual([back[0].request.conversationId, back[0].request.reason, back[0].request.notes.map((note) => note.text)], [room.id, 'review', [QUIET_NOTE]]);
  back[0].finish();
  await flush();
  h.clock.advance(2 * 60_000);
  h.scheduler.tick();
  await flush();
  assert.equal(turnsOf('ag_mgr').length, 1, 'one turn for everything her turn said');
  assert.deepEqual(openWakes(h.db), []);
  await h.dispatcher.stop();
});
