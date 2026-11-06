// B-050 live test round 4 (a work group of three, Codex): the manager read Mira's and Jonas's answers with chat.read
// during its turn, answered them – and was woken for the same lines right after, for a turn that only said "Consensus
// already confirmed … no further action needed" (17k input tokens). A complete chat.read of the turn's own chat now
// counts as seen when the turn ends done (chat/turn-reads.ts, agents/turn-finish.ts), so the dispatcher's stale check
// drops that wake – also when, as live, a colleague's next answer was still being written between those lines.
// Real chats, real chat.read tool, real planTurn/finishTurn; a fake engine result.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { planTurn } from '../../../src/runtime/agents/turn-prepare.ts';
import { finishTurn } from '../../../src/runtime/agents/turn-finish.ts';
import { isStaleMessageGroup, type WakeGroup } from '../../../src/runtime/agents/dispatch-groups.ts';
import { readThrough } from '../../../src/runtime/chat/turn-reads.ts';
import { chatTools } from '../../../src/runtime/tools/builtin/chat.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { agent } from '../chat/harness.ts';
import { setup } from './fixture.ts';

/** Tom in a work group with Mira and Jonas (no person); Mira's line is Tom's turn input. */
function scene() {
  const h = setup();
  h.org.add(agent('ag_mira', 'Mira'));
  h.org.add(agent('ag_jonas', 'Jonas'));
  const room = h.chats.create({ title: 'Tagline', agentIds: [h.tom.id, 'ag_mira', 'ag_jonas'], humans: false, createdBy: h.tom.id });
  const say = (authorId: string, body: string) => h.chats.send({ conversationId: room.id, authorId, authorKind: 'agent', body });
  const input = say('ag_mira', '@Tom My vote: "A place for your next thought."');
  const read = chatTools.find((tool) => tool.name === 'chat.read')!;
  const readAs = (runId: string, args: Record<string, unknown> = {}) =>
    read.run(args as never, { agent: h.tom, runId, conversationId: room.id, mode: 'general', services: h.services as RuntimeServices, signal: new AbortController().signal, status: () => {} } as ToolContext);
  const cursor = () => h.chats.members(room.id).find((member) => member.memberId === h.tom.id)!.readSeq;
  /** A plain message wake of Tom for the room – what the dispatcher checks before it starts a turn. */
  const wake = (): WakeGroup => ({
    conversationId: room.id, reason: 'message', rank: 0, dueAt: 0, createdAt: 0, priority: 0, overdue: false,
    wakes: [{ id: 'wk_1', agentId: h.tom.id, reason: 'message', conversationId: room.id, dueAt: 0, createdAt: 0, attempts: 0 }],
  });
  /** One turn of Tom: its input ends at Mira's line; `during` runs while it works (lines of others, chat.read). */
  const turn = async (runId: string, during: () => Promise<void>, stop: 'done' | 'error' = 'done') => {
    const request = h.request({ runId, conversationId: room.id });
    const plan = (await planTurn(h.services, request))!;
    await during();
    const result = stop === 'done' ? { text: 'Agreed – A place for your next thought.', stop } as const : { text: '', stop, error: { code: 'internal' as const, message: 'The model could not complete this turn.' } };
    finishTurn(h.services, plan, { ...h.routed(), lastSeq: input.seq }, request, h.attempt(result), undefined);
  };
  return { ...h, room, say, input, readAs, cursor, wake, turn };
}

test('round 4: lines a turn read with chat.read in its own chat count as seen when it ends – no second turn for them', async () => {
  const h = scene();
  let jonas = 0;
  await h.turn('run_tom', async () => {
    jonas = h.say('ag_jonas', '@Tom I agree with Mira, same wording.').seq; // arrives while Tom works
    await h.readAs('run_tom', { limit: 8 });
  });
  assert.ok(h.cursor() >= jonas, `Tom saw Jonas's line through chat.read (cursor ${h.cursor()}, line #${jonas})`);
  assert.equal(isStaleMessageGroup(h.chats, h.tom.id, h.wake()), true, 'the wake for the line he already read and answered is stale – no "already done" turn');
  const later = h.say('ag_mira', '@Tom One more thing: shall we tell Alex?').seq;
  assert.ok(later > h.cursor());
  assert.equal(isStaleMessageGroup(h.chats, h.tom.id, h.wake()), false, 'a line after the read still wakes him');
});

test('round 4: without chat.read or after a failed turn nothing more counts as seen; a line still being written stays new', async () => {
  const quiet = scene();
  await quiet.turn('run_plain', async () => { quiet.say('ag_jonas', '@Tom I agree.'); });
  assert.equal(quiet.cursor(), quiet.input.seq, 'the turn input only');
  assert.equal(isStaleMessageGroup(quiet.chats, quiet.tom.id, quiet.wake()), false, 'the line he never saw wakes him');

  const failed = scene();
  const before = failed.cursor();
  await failed.turn('run_failed', async () => {
    failed.say('ag_jonas', '@Tom I agree.');
    await failed.readAs('run_failed');
  }, 'error');
  assert.equal(failed.cursor(), before, 'a failed turn moves no cursor – its input and what it read come again');
  assert.ok(before < failed.input.seq);

  // Live shape: Mira's next answer was still being written between Jonas's vote and the manager's read.
  const writing = scene();
  let mira = '';
  let vote = 0;
  await writing.turn('run_writing', async () => {
    mira = writing.chats.beginAgentMessage(writing.room.id, 'ag_mira', 'run_mira').id; // Mira still writing
    vote = writing.say('ag_jonas', '@Tom I agree with Mira.').seq;
    await writing.readAs('run_writing');
  });
  assert.equal(writing.cursor(), vote, 'Jonas\'s finished vote after her open line counts as seen');
  const done = writing.chats.finishAgentMessage(mira, { body: '@Tom Then we are agreed.', state: 'final' });
  assert.ok(done.seq > writing.cursor(), 'her line moves behind what followed it once done');
  assert.equal(isStaleMessageGroup(writing.chats, writing.tom.id, writing.wake()), false, 'so it still reaches Tom');

  const last = scene(); // a line still being written with nothing finished after it ends the mark before it
  let open = 0;
  await last.turn('run_last', async () => {
    open = last.chats.beginAgentMessage(last.room.id, 'ag_jonas', 'run_jonas').seq;
    await last.readAs('run_last');
  });
  assert.ok(last.cursor() < open, `cursor ${last.cursor()} stays before the open line #${open}`);
});

test('round 4: readThrough – only a page that covers every line after the cursor counts, and only the turn\'s own chat', async () => {
  const line = (seq: number, state: 'final' | 'streaming' = 'final') => ({ seq, state });
  assert.equal(readThrough([line(4), line(5), line(7)], { cursor: 2, limit: 30 }), 7, 'a page shorter than its limit holds the whole chat');
  assert.equal(readThrough([line(5), line(6), line(7)], { cursor: 2, limit: 3 }), 0, 'a full page starting after #3 leaves a line out');
  assert.equal(readThrough([line(3), line(4), line(5)], { cursor: 2, limit: 3 }), 5, 'a full page that starts right after the cursor');
  assert.equal(readThrough([line(6), line(7)], { cursor: 2, limit: 30, afterSeq: 5 }), 0, 'a page after #5 skips #3–#5');
  assert.equal(readThrough([line(3), line(4, 'streaming'), line(5)], { cursor: 2, limit: 30 }), 5, 'an open line with a finished one after it moves behind it when done');
  assert.equal(readThrough([line(3), line(4), line(5, 'streaming')], { cursor: 2, limit: 30 }), 4, 'up to the last finished line');
  assert.equal(readThrough([], { cursor: 2, limit: 30 }), 0);

  const h = scene(); // a read of another chat, or a page back, marks nothing
  const other = h.chats.create({ title: 'Elsewhere', agentIds: [h.tom.id, 'ag_mira'], humans: false, createdBy: h.tom.id });
  await h.turn('run_other', async () => {
    h.say('ag_jonas', '@Tom I agree.');
    await h.readAs('run_other', { chatId: other.id });
    await h.readAs('run_other', { beforeSeq: 100 });
  });
  assert.equal(h.cursor(), h.input.seq);
});
