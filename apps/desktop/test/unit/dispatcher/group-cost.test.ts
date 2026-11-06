// B-050 group cost (live scenario 4, an AI-only work group: 9 turns, 705k input tokens). The manager polled chat.read
// five times in one turn waiting for its colleague's reply, and gave the colleague a task for the same request, so
// she answered twice. Here with the real dispatcher, delivery, wake queue, task service and chat/agent tools (a
// fake executor stands in for the turns): chat.send names who answers and says the reply comes as a new turn,
// chat.read right after one's own line says so too; the colleague waits for the sender's turn, a line and a task of
// that turn reach her in ONE turn, and her reply and result reach the sender in ONE turn after hers. A hand-over that
// arrives while she already answers runs after it, made aware of her line; one whose task is done needs no turn.
// Round 3 re-check (live run A): her [[silent]] answer still reaches the sender that ended its turn – as a pickup once free.
// Round 5 (live F): every chat.send note says an @mention wakes that colleague even in a quiet closing note.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { QUIET_DELAY_MS, QUIET_NOTE } from '../../../src/runtime/chat/quiet-pickup.ts';
import { agentTools } from '../../../src/runtime/tools/builtin/agents.ts';
import { chatTools } from '../../../src/runtime/tools/builtin/chat.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import { agent } from '../chat/harness.ts';
import { flush, openWakes, setup } from './fakes.ts';

const DONE = { summary: 'Jotnest', evidence: [{ kind: 'note' as const, label: 'Agreed in the naming room' }], verification: 'claimed_by_agent' as const };

function scene() {
  const h = setup();
  h.org.add(agent('ag_mgr', 'Manager', { mode: 'manager' }));
  h.org.add(agent('ag_mira', 'Mira', { managerId: 'ag_mgr' }));
  const direct = h.chats.create({ agentIds: ['ag_mgr'], createdBy: 'human' });
  const room = h.chats.create({ title: 'Note-taking app · naming', agentIds: ['ag_mgr', 'ag_mira'], humans: false, createdBy: 'ag_mgr', lead: 'ag_mgr' });
  const ctx = (agentId: string, runId: string, conversationId: string): ToolContext => ({
    agent: h.org.get(agentId)!, runId, conversationId, mode: 'general',
    services: h.services as RuntimeServices, signal: new AbortController().signal, status: () => {},
  } as ToolContext);
  const call = async (name: string, args: Record<string, unknown>, context: ToolContext): Promise<string> => {
    const def = [...chatTools, ...agentTools].find((item) => item.name === name)!;
    const output = await def.run(args as never, context) as ToolOutput;
    return (output.content[0] as { text: string }).text;
  };
  const turnsOf = (agentId: string) => h.executor.calls.filter((item) => item.request.agentId === agentId);
  return { ...h, direct, room, ctx, call, turnsOf };
}

test('scenario 4: no polling hint missing, one turn of the colleague for line + task, one turn of the sender for reply + result', async () => {
  const h = scene();
  h.dispatcher.start();
  h.chats.send({ conversationId: h.direct.id, body: 'Find a name for our note app with Mira, without me. Then one sentence to me.', authorId: 'human' });
  await flush();
  const manager = h.executor.last();
  const ctx = h.ctx('ag_mgr', manager.request.runId, h.direct.id);

  const sent = JSON.parse(await h.call('chat.send', { chatId: h.room.id, text: '@Mira My shortlist: Notelo, Jotnest, Folio. Your pick?' }, ctx));
  assert.deepEqual(sent.woken, ['Mira']);
  assert.match(sent.note, /^Mira answers after this turn of mine; a reply comes to me as a new turn .*I end this turn now instead of waiting or reading the chat again/);
  await flush();
  assert.equal(h.turnsOf('ag_mira').length, 0, 'Mira waits for the turn that wrote to her – she would only half answer it');

  // (a) The poll of the live run: the read right after the own line says why waiting cannot work.
  const read = await h.call('chat.read', { chatId: h.room.id, limit: 10 }, ctx);
  assert.match(read, /Your pick\?/);
  assert.match(read, /\n\nNothing new since my #\d+ of this turn\. Mira answers after this turn of mine; a reply comes to me as a new turn/);

  // (b) The same request as a task as well: it rides along with her line – one turn.
  const delegated = JSON.parse(await h.call('agents.delegate', { to: 'ag_mira', chatId: h.room.id, title: 'Agree on the app name' }, ctx));
  assert.match(delegated.note, /^Mira already has a line of this chat to answer: this task reaches them in the same turn\. Their reply comes to me as a new turn/);
  await flush();
  const mira = h.turnsOf('ag_mira');
  assert.equal(mira.length, 1, 'the hand-over is parallel work: it starts now, with her line');
  assert.deepEqual([mira[0].request.conversationId, mira[0].request.taskId, mira[0].request.reason], [h.room.id, delegated.taskId, 'message']);
  assert.ok(mira[0].request.notes.some((note) => note.text.startsWith('Handoff from Manager')), 'with the checkpoint');
  manager.finish(); // the manager ends its turn, as told
  await flush();
  assert.equal(h.turnsOf('ag_mgr').length, 1);

  // Mira's one turn finishes the task and answers; the manager hears both after her turn – in one turn.
  h.tasks.complete(delegated.taskId, DONE, 'ag_mira');
  await flush();
  assert.equal(h.turnsOf('ag_mgr').length, 1, 'the result of a running turn waits for its end');
  h.chats.send({ conversationId: h.room.id, body: 'My vote is Jotnest too.', authorId: 'ag_mira', runId: mira[0].request.runId });
  await flush();
  assert.equal(h.turnsOf('ag_mgr').length, 1, 'so does its line');
  mira[0].finish();
  await flush();
  const back = h.turnsOf('ag_mgr');
  assert.equal(back.length, 2, 'one manager turn for her reply and her result');
  assert.deepEqual([back[1].request.conversationId, back[1].request.taskId, back[1].request.reason], [h.room.id, delegated.taskId, 'message']);
  back[1].finish();
  await flush();
  assert.equal(h.turnsOf('ag_mira').length, 1, 'Mira answered once');
  assert.equal(h.executor.calls.length, 3, 'three turns where the live run needed six for the first exchange');
  assert.deepEqual(openWakes(h.db).filter((wake) => wake.agent_id === 'ag_mira' || wake.agent_id === 'ag_mgr'), []);
  await h.dispatcher.stop();
});

test('chat.send and chat.read notes: nobody woken in a group, no hint once a reply came or without a colleague', async () => {
  const h = scene();
  h.org.add(agent('ag_tom', 'Tom'));
  const group = h.chats.create({ title: 'Launch', agentIds: ['ag_mgr', 'ag_mira', 'ag_tom'], humans: false, createdBy: 'ag_mgr', lead: 'ag_mgr' });
  const ctx = h.ctx('ag_mgr', 'run_mgr', h.direct.id);
  const unaddressed = JSON.parse(await h.call('chat.send', { chatId: group.id, text: 'Ideas, anyone?' }, ctx));
  assert.deepEqual(unaddressed.woken, []);
  assert.match(unaddressed.note, /^No colleague is woken by this line: an agent's line reaches the agents it @mentions/);
  assert.doesNotMatch(await h.call('chat.read', { chatId: group.id }, ctx), /Nothing new since/, 'nobody to wait for');
  const both = JSON.parse(await h.call('chat.send', { chatId: group.id, text: 'Mira, Tom: your picks?', mentions: ['ag_mira', 'ag_tom'] }, ctx));
  assert.deepEqual(both.woken, ['Mira', 'Tom']);
  assert.match(both.note, /^Mira and Tom answer after this turn of mine/);
  assert.match(await h.call('chat.read', { chatId: group.id }, ctx), /Nothing new since my #\d+ of this turn\. Mira and Tom answer/);
  h.chats.send({ conversationId: group.id, body: '@Manager Jotnest', authorId: 'ag_mira', mentions: ['ag_mgr'] });
  assert.doesNotMatch(await h.call('chat.read', { chatId: group.id }, ctx), /Nothing new since/, 'a reply came');
  assert.doesNotMatch(await h.call('chat.read', { chatId: group.id }, h.ctx('ag_mgr', 'run_other', h.direct.id)), /Nothing new since/, 'not a line of this turn');
  const toPerson = JSON.parse(await h.call('chat.send', { text: 'Done, see the room.' }, ctx));
  assert.equal(toPerson.note, undefined, 'a chat with the person only: no colleague note');
});

test('round 5 (live F: "@Mira agreed, thanks" as a quiet closing note woke her for nothing): every chat.send note says a closing note names nobody with @', async () => {
  const h = scene();
  h.org.add(agent('ag_tom', 'Tom'));
  const group = h.chats.create({ title: 'Launch', agentIds: ['ag_mgr', 'ag_mira', 'ag_tom'], humans: false, createdBy: 'ag_mgr', lead: 'ag_mgr' });
  const ctx = h.ctx('ag_mgr', 'run_mgr', h.direct.id);
  const closing = /An @mention wakes that colleague even in a quiet line \(level "silent"\) or a \[\[silent\]\] note, so my closing note names nobody with @\.$/;
  const nobody = JSON.parse(await h.call('chat.send', { chatId: group.id, text: 'Ideas, anyone?' }, ctx));
  assert.match(nobody.note, closing);
  const thanks = JSON.parse(await h.call('chat.send', { chatId: group.id, text: '@Mira agreed, thanks', mentions: ['ag_mira'], level: 'silent' }, ctx));
  assert.deepEqual(thanks.woken, ['Mira'], 'the quiet closing note of the live run woke her');
  assert.match(thanks.note, /^Mira answers after this turn of mine; .*I end this turn now/);
  assert.match(thanks.note, closing);
  assert.equal(JSON.parse(await h.call('chat.send', { text: 'Done, see the room.' }, ctx)).note, undefined, 'a chat with the person only: no colleague note');
});

test('a hand-over that arrives while the colleague already answers runs after it, aware of her line; a finished one needs no turn', async () => {
  const h = scene();
  h.dispatcher.start();
  h.chats.send({ conversationId: h.room.id, body: '@Mira Your pick for the name?', authorId: 'ag_mgr' }); // a line of no running turn
  await flush();
  const answering = h.executor.last();
  assert.deepEqual([answering.request.agentId, answering.request.reason], ['ag_mira', 'message'], 'not held: no running turn wrote it');
  const ctx = h.ctx('ag_mgr', 'run_mgr', h.direct.id);
  const first = JSON.parse(await h.call('agents.delegate', { to: 'ag_mira', chatId: h.room.id, title: 'Agree on the app name' }, ctx));
  assert.match(first.note, /^Mira is working in this chat right now; this task follows that turn/);
  const reply = h.chats.send({ conversationId: h.room.id, body: 'Jotnest.', authorId: 'ag_mira', runId: answering.request.runId });
  answering.finish();
  await flush();
  const after = h.turnsOf('ag_mira').at(-1)!;
  assert.deepEqual([after.request.taskId, after.request.reason], [first.taskId, 'handoff']);
  const aware = after.request.notes.at(-1)!.text;
  assert.match(aware, new RegExp(`^I already wrote in this chat after this task reached me \\(#${reply.seq}\\), in a turn that did not have the task yet\\. If that already does what it asks, I finish it with tasks\\.complete`));
  after.finish();
  for (const turn of h.turnsOf('ag_mgr')) turn.finish(); // woken by her reply once her turn ended
  await flush();

  // The same race, but her answering turn finished the task itself (its anchor line was in her input): no second turn.
  h.chats.send({ conversationId: h.room.id, body: '@Mira And a tagline?', authorId: 'ag_mgr' });
  await flush();
  const again = h.turnsOf('ag_mira').at(-1)!;
  assert.notEqual(again, after);
  const second = JSON.parse(await h.call('agents.delegate', { to: 'ag_mira', chatId: h.room.id, title: 'Find a tagline' }, ctx));
  h.tasks.complete(second.taskId, DONE, 'ag_mira');
  again.finish();
  await flush();
  assert.equal(h.turnsOf('ag_mira').at(-1), again, 'the hand-over of a finished task is settled without a turn');
  assert.deepEqual(openWakes(h.db).filter((wake) => wake.agent_id === 'ag_mira'), []);
  for (const turn of h.turnsOf('ag_mgr')) turn.finish();
  await h.dispatcher.stop();
});

test('round 3 re-check (live run A): her [[silent]] vote still reaches the manager that ended its turn as told – once it is free, once; a quiet line after it closes', async () => {
  const h = scene();
  h.dispatcher.start();
  h.chats.send({ conversationId: h.direct.id, body: 'Find a name for our note app with Mira, without me. Then one sentence to me.', authorId: 'human' });
  await flush();
  const manager = h.executor.last();
  const sent = JSON.parse(await h.call('chat.send', { chatId: h.room.id, text: '@Mira My shortlist: Notelo, Jotnest. What would you suggest?' }, h.ctx('ag_mgr', manager.request.runId, h.direct.id)));
  assert.match(sent.note, /in a chat of two a quiet one too, once I am free\)\. I end this turn now/);
  manager.finish(); // as told
  await flush();
  const [mira] = h.turnsOf('ag_mira');
  // The live run: she agreed and tagged her answer [[silent]] – before, nothing ever woke the manager again.
  h.chats.send({ conversationId: h.room.id, body: 'My vote is Notelo – let us choose it.', authorId: 'ag_mira', authorKind: 'agent', silent: true, runId: mira.request.runId });
  mira.finish();
  await flush();
  assert.equal(h.turnsOf('ag_mgr').length, 1, 'a quiet line wakes nobody at once');
  h.clock.advance(QUIET_DELAY_MS);
  h.scheduler.tick();
  await flush();
  const back = h.turnsOf('ag_mgr');
  assert.equal(back.length, 2, 'the manager picks her answer up once free');
  assert.deepEqual([back[1].request.conversationId, back[1].request.reason, back[1].request.notes.map((note) => note.text)], [h.room.id, 'review', [QUIET_NOTE]]);
  h.chats.send({ conversationId: h.room.id, body: 'Notelo it is; Alex knows.', authorId: 'ag_mgr', authorKind: 'agent', silent: true, runId: back[1].request.runId });
  back[1].finish(); // a fake turn leaves the cursor: the marks keep it from repeating
  await flush();
  h.clock.advance(QUIET_DELAY_MS);
  h.scheduler.tick();
  await flush();
  assert.deepEqual([h.turnsOf('ag_mgr').length, h.turnsOf('ag_mira').length], [2, 1], 'its quiet closing note is nobody\'s to pick up; hers is not picked up twice');
  assert.deepEqual(openWakes(h.db), []);
  await h.dispatcher.stop();
});
