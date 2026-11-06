// B-059 track "finish": #42 a plain answer in the person's 1:1 is never quiet (agents/publishing.ts resolveVisibility,
// personPair; wired in turn-finish.ts) – [[silent]] stays the closing note after work was done, in groups, on a report wake
// and after another post of the run; #74 the answer's meta carries its step count (meta.steps, or meta.thought) for the
// chat's line from the first frame; #86 the outage line (agents/outage-line.ts, engine and pre-engine outages) and the
// task's Done/Blocked lines written during the agent's turn in that chat (tasks/lifecycle.ts) carry meta.fromRun.
// Owns: these assertions only. Never: real engines, accounts, timers or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { personPair, resolveVisibility } from '../../../src/runtime/agents/publishing.ts';
import { outageLine } from '../../../src/runtime/agents/outage-line.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { EngineTurnInput } from '../../../src/runtime/engines/types.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import type { WakeReason } from '../../../src/shared/model/runs.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { agent } from '../chat/harness.ts';
import { setup } from './fixture.ts';

function rig() {
  const h = setup();
  const journal = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  const routing: { fail?: Error } = {};
  Object.assign(h.services, { runs: journal, router: { route: async () => { if (routing.fail) throw routing.fail; return h.route; } } });
  Object.assign(h.services.accounts, { list: () => [], markUnavailable: () => false, markLimited: () => {} });
  Object.assign(h.services.catalog, { list: () => [] });
  let count = 0;
  const run = async (reason: WakeReason = 'message', taskId?: string) => {
    h.wakes.done(h.wakes.claim(h.tom.id, Number.MAX_SAFE_INTEGER).map((wake) => wake.id));
    const outcome = await new TurnExecutor(() => h.services).execute(h.request({ runId: `run_${++count}`, reason, ...(taskId ? { taskId } : {}) }));
    return { ...outcome, message: outcome.messageId ? h.chats.message(outcome.messageId) : undefined };
  };
  const ask = (body: string) => h.chats.send({ conversationId: h.chat.id, authorId: HUMAN_ID, body });
  const unread = () => h.chats.summary(h.chat.id).unread;
  const replies = () => h.notified.filter((item) => item.kind === 'reply' || item.kind === 'important').length;
  const lines = (prefix: string): Message[] => h.chats.messages(h.chat.id, { limit: 200 }).filter((message) => message.kind === 'status' && message.body.startsWith(prefix));
  const task = () => {
    const created = h.tasks.create({ conversationId: h.chat.id, title: 'Cut the intro', assigneeKind: 'agent', assigneeId: h.tom.id, createdBy: HUMAN_ID });
    h.tasks.claim(created.id, h.tom.id);
    return created;
  };
  return { ...h, journal, routing, run, ask, unread, replies, lines, task };
}

/** One engine-native call that ran (Claude names: Read only looks, Write changes something). */
function tool(input: EngineTurnInput, callId: string, name: string): void {
  input.onEvent({ type: 'tool_start', callId, name, args: { file_path: 'notes/intro.md' }, own: true });
  input.onEvent({ type: 'tool_end', callId, ok: true, summary: 'ok' });
}

test('#42 resolveVisibility: [[silent]] on a plain answer in the person\'s 1:1 notifies; after a change, in a group, on a report, after another post or unknown it stays quiet', () => {
  const base = { awaited: true, mustSee: false, reason: 'message' as WakeReason, tag: 'silent' as const, personPair: true, changed: false, postedElse: () => false };
  assert.equal(resolveVisibility(base), 'notify', 'the person asked – a plain answer');
  assert.equal(resolveVisibility({ ...base, changed: true }), 'silent', 'the closing note after work was done (B-050 round 3)');
  assert.equal(resolveVisibility({ ...base, personPair: false }), 'silent', 'groups keep their quiet lines');
  assert.equal(resolveVisibility({ ...base, awaited: false }), 'silent', 'nobody waits');
  assert.equal(resolveVisibility({ ...base, reason: 'report' }), 'silent', 'a report wake with nothing left to tell (org/reports.ts)');
  assert.equal(resolveVisibility({ ...base, postedElse: () => true }), 'silent', 'the run already posted there – no second push');
  assert.equal(resolveVisibility({ ...base, changed: undefined }), 'silent', 'not known: no upgrade');
  assert.equal(resolveVisibility({ ...base, tag: 'internal' }), 'silent', '[[internal]] keeps its meaning (only the safety net)');
  assert.equal(resolveVisibility({ ...base, tag: 'notify' }), 'notify');
});

test('#42 personPair: a room of two with the owner or a person of the organisation – never with an agent, a bridged contact or in a group', () => {
  const m = (memberId: string, kind: 'human' | 'agent' | 'external', leftAt?: number) => ({ memberId, kind, ...(leftAt ? { leftAt } : {}) });
  assert.equal(personPair([m('ag_tom', 'agent'), m(HUMAN_ID, 'human')], 'ag_tom'), true);
  assert.equal(personPair([m('ag_tom', 'agent'), m('per_0123456789ab', 'human')], 'ag_tom'), true);
  assert.equal(personPair([m('ag_tom', 'agent'), m('ag_mara', 'agent')], 'ag_tom'), false);
  assert.equal(personPair([m('ag_tom', 'agent'), m('ext:tg:42:Sam', 'external')], 'ag_tom'), false);
  assert.equal(personPair([m('ag_tom', 'agent'), m(HUMAN_ID, 'human'), m('ag_mara', 'agent')], 'ag_tom'), false);
  assert.equal(personPair([m('ag_tom', 'agent'), m(HUMAN_ID, 'human'), m('ag_mara', 'agent', 5)], 'ag_tom'), true, 'a member who left does not count');
  assert.equal(personPair([m('ag_mara', 'agent'), m(HUMAN_ID, 'human')], 'ag_tom'), false, 'not the agent\'s room');
});

test('#42 the person asks in their 1:1: a [[silent]] plain answer arrives with unread and notification; a closing note after a change stays quiet; a group is unchanged', async () => {
  const h = rig();
  h.ask('Which file holds the intro?');
  const [unread, replies] = [h.unread(), h.replies()];
  h.state.script = async (input) => { tool(input, 'r1', 'Read'); return { text: 'notes/intro.md holds it. [[silent]]', stop: 'done' }; };
  const asked = await h.run();
  assert.deepEqual([asked.message?.body, asked.message?.silent], ['notes/intro.md holds it.', false]);
  assert.deepEqual([h.unread(), h.replies()], [unread + 1, replies + 1], 'unread and notified');
  assert.equal(h.journal.items('run_1').find((item) => item.name === 'Answer')?.data.visibility, 'notify');

  h.ask('Write notes/launch-checklist.md, no need to report back.');
  const [unread2, replies2] = [h.unread(), h.replies()];
  h.state.script = async (input) => { tool(input, 'w1', 'Write'); return { text: 'Checklist written: notes/launch-checklist.md. [[silent]]', stop: 'done' }; };
  const done = await h.run();
  assert.equal(done.message?.silent, true, 'B-050 round 3: the closing note after work stays quiet');
  assert.deepEqual([h.unread(), h.replies()], [unread2, replies2]);

  const mara = h.org.add(agent('ag_mara', 'Mara'));
  h.chats.setMembers(h.chat.id, { add: [mara.id] }, HUMAN_ID);
  h.ask('Which file holds the outro?');
  h.state.script = async () => ({ text: 'notes/outro.md. [[silent]]', stop: 'done' });
  assert.equal((await h.run()).message?.silent, true, 'a group keeps its quiet answer');
});

test('#74 the answer carries its step count (meta.steps) – or meta.thought for a run that only reasoned; a plain answer neither', async () => {
  const h = rig();
  h.ask('Check both notes.');
  h.state.script = async (input) => { tool(input, 'r1', 'Read'); tool(input, 'r2', 'Grep'); return { text: 'Both are fine.', stop: 'done' }; };
  const worked = (await h.run()).message!;
  assert.deepEqual([worked.meta.steps, worked.meta.thought, worked.meta.model], [2, undefined, 'claude-opus-5-5']);

  h.ask('Yes or no?');
  h.state.script = async (input) => {
    input.onEvent({ type: 'reasoning', delta: 'Weighing it.', id: 'rs_1' });
    input.onEvent({ type: 'reasoning_end', id: 'rs_1' });
    return { text: 'Yes.', stop: 'done' };
  };
  const thought = (await h.run()).message!;
  assert.deepEqual([thought.meta.steps, thought.meta.thought], [undefined, true]);

  h.ask('Hi?');
  h.state.script = async () => ({ text: 'Hi.', stop: 'done' });
  const plain = (await h.run()).message!;
  assert.deepEqual([plain.meta.steps, plain.meta.thought, plain.meta.model], [undefined, undefined, 'claude-opus-5-5']);

  h.ask('Run the tests.');
  h.state.script = async (input) => { tool(input, 's1', 'Bash'); return { text: 'Half done', stop: 'error', error: { code: 'internal', message: 'The engine crashed.' } }; };
  const failed = (await h.run()).message!;
  assert.deepEqual([failed.state, failed.meta.steps], ['failed', 1], 'a failed answer keeps its line too');
});

test('#86 the outage line names the run that met the outage – engine outage, outage before the engine, and the plain call', async () => {
  const h = rig();
  const work = h.task();
  h.state.script = async () => ({ text: '', stop: 'error', error: { code: 'unavailable', message: 'Claude Code is not signed in.' } });
  await h.run('retry', work.id);
  assert.deepEqual(h.lines('Paused:').map((line) => [line.body, line.meta.fromRun]), [['Paused: Claude Code is not signed in. – continues by itself', 'run_1']]);

  const other = h.tasks.create({ conversationId: h.chat.id, title: 'Grade the outro', assigneeKind: 'agent', assigneeId: h.tom.id, createdBy: HUMAN_ID });
  h.tasks.claim(other.id, h.tom.id);
  h.routing.fail = new WorkforceError('unavailable', 'No model is connected.');
  await h.run('retry', other.id);
  assert.equal(h.lines('Paused: No model').at(-1)?.meta.fromRun, 'run_2', 'failed before the engine');

  const third = h.tasks.create({ conversationId: h.chat.id, title: 'Mix the audio', assigneeKind: 'agent', assigneeId: h.tom.id, createdBy: HUMAN_ID });
  outageLine(h.services, h.tasks.get(third.id)!, 'a usage limit was reached');
  assert.equal(h.lines('Paused: a usage limit').at(-1)?.meta.fromRun, undefined, 'without a run: as before');
});

test('#86 the Done and Blocked lines written during the agent\'s turn in the task\'s chat name that run; other lines and other moments stay plain', () => {
  const h = rig();
  const work = h.task();
  h.running.push({ agentId: h.tom.id, runId: 'run_5', conversationId: h.chat.id, taskId: work.id, note: '', startedAt: 0 });
  h.tasks.setStatus(work.id, 'blocked', h.tom.id, 'The render host is down');
  assert.equal(h.lines('Blocked:').at(-1)?.meta.fromRun, 'run_5');
  h.tasks.setStatus(work.id, 'working', h.tom.id);
  assert.equal(h.lines('Working:').at(-1)?.meta.fromRun, undefined, 'only Done and Blocked');
  h.tasks.complete(work.id, { summary: 'Intro cut to 12 s', evidence: [{ kind: 'file', label: 'intro.mp4' }], verification: 'claimed_by_agent' }, h.tom.id);
  assert.equal(h.lines('Done: Cut').at(-1)?.meta.fromRun, 'run_5');

  h.running.length = 0;
  h.running.push({ agentId: h.tom.id, runId: 'run_6', conversationId: 'chat_elsewhere', note: '', startedAt: 0 });
  const later = h.tasks.create({ conversationId: h.chat.id, title: 'Grade the outro', assigneeKind: 'agent', assigneeId: h.tom.id, createdBy: HUMAN_ID });
  h.tasks.claim(later.id, h.tom.id);
  h.tasks.complete(later.id, { summary: 'Outro graded', evidence: [{ kind: 'file', label: 'outro.mp4' }], verification: 'claimed_by_agent' }, h.tom.id);
  assert.equal(h.lines('Done: Grade').at(-1)?.meta.fromRun, undefined, 'its turn runs in another chat');
  h.tasks.setStatus(later.id, 'open', HUMAN_ID);
  h.tasks.setStatus(later.id, 'blocked', HUMAN_ID, 'Waiting for the music rights');
  assert.equal(h.lines('Blocked: Grade').at(-1)?.meta.fromRun, undefined, 'the person blocked it');
});
