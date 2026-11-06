// B-047 D4 chat.send (tools/builtin/chat.ts): every post carries the run's runId (meta.sentDuringRun);
// `status: true` posts one quiet kind 'status' line (≤ 200 characters, runId and meta.fromRun, no
// unread, wakes nobody), refuses files/urgent/mentions/replyTo and is rate-limited per run; `silent`
// posts visibly without unread or notification and still reaches a mentioned colleague. B-049 F8: the result
// names a cut status line and a post the important brake sent as normal (both left the tool description).
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { STATUS_CHARS, STATUS_GAP_MS, STATUS_PER_RUN, chatTools } from '../../../src/runtime/tools/builtin/chat.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { agent, harness } from './harness.ts';

function setup() {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava'));
  h.org.add(agent('ag_bo', 'Bo'));
  const chat = h.chats.create({ agentIds: ['ag_ava', 'ag_bo'], createdBy: HUMAN_ID, lead: 'ag_ava' });
  const tool = chatTools.find((item) => item.name === 'chat.send')!;
  const ctx = (runId = 'run_s') => ({
    agent: h.org.get('ag_ava')!, runId, conversationId: chat.id, mode: 'general',
    services: h.services as RuntimeServices, signal: new AbortController().signal, status: () => {},
  } as ToolContext);
  const send = async (args: Record<string, unknown>, runId?: string) => {
    const out = await tool.run(args as never, ctx(runId));
    return { error: out.isError === true, data: out.isError ? undefined : JSON.parse((out.content[0] as { text: string }).text) as { ok: boolean; messageId?: string; note?: string } };
  };
  h.db.run('DELETE FROM wakes');
  return { ...h, chat, send };
}

test('status: one quiet kind status line of the run – runId, fromRun, at most 200 characters, no unread, no wake', async () => {
  const h = setup();
  const unread = h.chats.summary(h.chat.id).unread;
  const { data } = await h.send({ text: `Rendering the second cut\n${'x'.repeat(400)}`, status: true });
  const line = h.chats.message(data!.messageId!)!;
  assert.deepEqual([line.kind, line.silent, line.runId, line.meta.fromRun, line.authorId], ['status', true, 'run_s', 'run_s', 'ag_ava']);
  assert.ok(line.body.length <= STATUS_CHARS && line.body.startsWith('Rendering the second cut x'), 'one line, clipped');
  assert.deepEqual(line.meta.status?.details, { by: 'agent', runId: 'run_s' });
  assert.equal(h.chats.summary(h.chat.id).unread, unread);
  assert.deepEqual(h.wakeRows(), []);
  assert.equal(h.notified.length, 0);
});

test('status: refuses files, urgent, mentions and replyTo; rate-limited per run', async () => {
  const h = setup();
  for (const extra of [{ urgent: true }, { mentions: ['ag_bo'] }, { files: ['a.png'] }, { replyTo: 'msg_1' }]) {
    assert.equal((await h.send({ text: 'Working', status: true, ...extra })).error, true, JSON.stringify(extra));
  }
  assert.equal((await h.send({ text: 'Step 1', status: true })).data?.ok, true);
  const limited = await h.send({ text: 'Step 2', status: true });
  assert.equal(limited.data?.ok, false, 'too soon');
  assert.match(limited.data?.note ?? '', /at most one status update every 10 seconds/);
  assert.equal((await h.send({ text: 'Other run', status: true }, 'run_t')).data?.ok, true, 'per run');
  h.clock.advance(STATUS_GAP_MS);
  assert.equal((await h.send({ text: 'Step 2', status: true })).data?.ok, true);
  for (let i = 2; i < STATUS_PER_RUN; i++) { h.clock.advance(STATUS_GAP_MS); await h.send({ text: `Step ${i + 1}`, status: true }); }
  h.clock.advance(STATUS_GAP_MS);
  assert.equal((await h.send({ text: 'One too many', status: true })).data?.ok, false, `at most ${STATUS_PER_RUN} per run`);
});

test('B-049 F8: the result says when a status line was cut and when the important brake sent a post as normal', async () => {
  const h = setup();
  assert.match((await h.send({ text: 'x'.repeat(STATUS_CHARS + 50), status: true })).data?.note ?? '', new RegExp(`Cut to ${STATUS_CHARS} characters`));
  assert.equal((await h.send({ text: 'Short', status: true }, 'run_u')).data?.note, undefined, 'nothing cut, no note');
  const notes: string[] = [];
  for (let i = 1; i <= 6; i++) notes.push((await h.send({ text: `Blocker ${i}`, level: 'important' })).data?.note ?? '');
  assert.ok(notes.slice(0, 5).every((note) => !note.includes('Sent as normal')), notes.join('\n'));
  assert.match(notes[5], /^Sent as normal, not important: I sent too many important messages/);
});

test('a chat.send post carries its run; a silent one is visible, not unread, notifies nobody and still reaches a mentioned colleague', async () => {
  const h = setup();
  const { data } = await h.send({ text: 'Here is the draft.' });
  const post = h.chats.message(data!.messageId!)!;
  assert.deepEqual([post.kind, post.runId, post.meta.sentDuringRun, post.silent], ['text', 'run_s', true, false]);
  assert.equal(h.notified.at(-1)?.kind, 'reply', 'a default post notifies');

  const unread = h.chats.summary(h.chat.id).unread;
  const notified = h.notified.length;
  h.db.run('DELETE FROM wakes');
  await h.send({ text: '@Bo please check the colours', silent: true });
  assert.equal(h.chats.summary(h.chat.id).unread, unread);
  assert.equal(h.notified.length, notified);
  assert.deepEqual(h.wakeRows().map((row) => row.agent_id), ['ag_bo']);
});

test('status: colleagues read an agent\'s own status line with its name; app lines by the agent stay "· text"', async () => {
  const { renderMessages } = await import('../../../src/runtime/context/render.ts');
  const h = setup();
  await h.send({ text: 'Rendering the second cut', status: true });
  h.chats.status(h.chat.id, { type: 'note', text: 'Ava reads the important message after the current step.', details: { deferredUrgent: true } }, { authorId: 'ag_ava' });
  const { lines } = renderMessages({ services: h.services as RuntimeServices, agentId: 'ag_bo', humanName: 'Sam', zone: 'UTC', now: Date.now() }, h.chats.messages(h.chat.id), { images: false });
  assert.ok(lines.includes('· Ava: Rendering the second cut'), lines.join('\n'));
  assert.ok(lines.includes('· Ava reads the important message after the current step.'), 'an app line keeps its own wording');
});
