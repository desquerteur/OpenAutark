// Background turns (B-047 D4, agents/publishing.ts + turn-finish.ts, replacing T06's quiet posts):
// a retry, review, schedule, child, task or handoff turn keeps an untagged final text in its run
// journal – no chat message, no unread, no notification, no wakes – unless the person must see it:
// it asked them something (also human.ask without a taskId), @mentions them, blocked the task or
// handed it to them, or works on an urgent task (posted + notifies); one that @mentions a colleague
// posts quietly and still reaches them. A turn that took in a new line of the person (steered in or
// in its delta; an external agent's is never theirs, C8) is awaited and loud. Finishing a task is no
// chat news: the 'Done' line and the person's 'done' notification say it (tasks.complete notify:false
// skips the notification). Tags are honoured on any turn. A task turn that only met an outage leaves
// no failed bubble – one quiet line per outage instead.
// Owns: these assertions only. Never: real engines, accounts, timers or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { mustSee } from '../../../src/runtime/agents/publishing.ts';
import type { WakeReason } from '../../../src/shared/model/runs.ts';
import type { TurnRequest } from '../../../src/runtime/agents/turn-types.ts';
import type { ToolOutput } from '../../../src/runtime/tools/types.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { agent } from '../chat/harness.ts';
import { setup } from './fixture.ts';

function taskSetup() {
  const h = setup();
  const mara = h.org.add(agent('ag_mara', 'Mara'));
  h.chats.setMembers(h.chat.id, { add: [mara.id] }, HUMAN_ID);
  const task = h.tasks.create({ conversationId: h.chat.id, title: 'Cut the intro', assigneeKind: 'agent', assigneeId: h.tom.id, createdBy: 'human' });
  h.tasks.claim(task.id, h.tom.id);
  Object.assign(h.services, { router: { route: async () => h.route } });
  Object.assign(h.services.accounts, { list: () => [], markUnavailable: () => false, markLimited: () => {} });
  Object.assign(h.services.catalog, { list: () => [] });
  let runs = 0;
  const run = (reason: WakeReason, patch: Partial<TurnRequest> = {}) => {
    h.wakes.done(h.wakes.claim(h.tom.id, Number.MAX_SAFE_INTEGER).map((wake) => wake.id));
    return new TurnExecutor(() => h.services).execute(h.request({ runId: `run_${++runs}`, taskId: task.id, reason, ...patch }));
  };
  const last = () => h.chats.messages(h.chat.id).filter((message) => message.authorId === h.tom.id && message.kind === 'text').at(-1)!;
  const posts = () => h.chats.messages(h.chat.id).filter((message) => message.authorId === h.tom.id && message.kind === 'text').length;
  const unread = () => h.chats.summary(h.chat.id).unread;
  const wakesFor = (agentId: string) => h.wakes.list(agentId).filter((wake) => wake.claimedAt === undefined && wake.reason === 'message');
  /** The run journal's final answers (run items 'Answer'). */
  const answers = () => h.items.filter((item) => item.kind === 'note' && (item as { name?: string }).name === 'Answer').map((item) => item.data as { text: string; visibility: string; messageId?: string });
  return { ...h, mara, task, run, last, posts, unread, wakesFor, answers };
}

test('mustSee: asking or mentioning the person, an urgent, blocked or waiting task, a new human step', () => {
  const step = (status: 'open' | 'done') => ({ assigneeKind: 'human' as const, status });
  const before = { steps: [] };
  assert.equal(mustSee({ before, after: { status: 'working', steps: [] }, asks: false }), false);
  for (const status of ['blocked', 'needs_you'] as const) assert.equal(mustSee({ before, after: { status, steps: [] }, asks: false }), true, status);
  for (const status of ['done', 'cancelled'] as const) assert.equal(mustSee({ before, after: { status, steps: [] }, asks: false }), false, `${status}: the task lifecycle says it`);
  assert.equal(mustSee({ before, after: { status: 'working', steps: [] }, asks: true }), true, 'an ask block');
  assert.equal(mustSee({ before, after: { status: 'working', steps: [] }, asks: false, mentionsPerson: true }), true, 'it @mentions the person');
  assert.equal(mustSee({ before, after: { status: 'working', steps: [step('open')] as never }, asks: false }), true, 'a new human to-do');
  assert.equal(mustSee({ before: { steps: [step('open')] as never }, after: { status: 'working', steps: [step('open')] as never }, asks: false }), false, 'an old to-do is no news');
  assert.equal(mustSee({ before: undefined, after: undefined, asks: false }), false, 'no task, nothing asked');
  assert.equal(mustSee({ before, after: { status: 'working', steps: [], priority: 2 }, asks: false }), true, 'an urgent task');
  assert.equal(mustSee({ before, after: { status: 'working', steps: [], priority: 1 }, asks: false }), false, 'high is not urgent');
});

test('a background turn that takes in a new message from the person answers loudly – steered in or in its delta (regression)', async () => {
  const h = taskSetup();
  // An important message steered into the running retry turn: its own message wake is stale afterwards.
  const asked = h.chats.send({ conversationId: h.chat.id, authorId: HUMAN_ID, body: 'Where are we with the intro?', priority: 'important' });
  const before = h.unread();
  h.state.script = async () => ({ text: 'Rendering the second cut, about ten minutes.', stop: 'done' });
  await h.run('retry', { control: { lastSeq: 0, steeredSeq: asked.seq } });
  assert.equal(h.last().silent, false, 'the answer reaches the person');
  assert.equal(h.unread(), before + 1);

  // A retry whose delta holds a human message (e.g. sent during an outage) is loud too.
  h.chats.send({ conversationId: h.chat.id, authorId: HUMAN_ID, body: 'Also make it brighter.' });
  const read = h.unread(); // writing marks the chat read for the person
  h.context.delta = () => ({ text: 'You: Also make it brighter.', images: [], lastSeq: h.chats.messages(h.chat.id).at(-1)!.seq });
  await h.run('retry');
  assert.equal(h.last().silent, false);
  assert.equal(h.unread(), read + 1);

  // Nothing new from the person: the text stays in the run journal (only its own and status lines are behind the cursor).
  h.state.script = async () => ({ text: 'Still rendering.', stop: 'done' });
  const posted = h.posts();
  await h.run('retry');
  assert.equal(h.posts(), posted, 'no chat message');
  assert.deepEqual(h.answers().at(-1), { answer: true, text: 'Still rendering.', visibility: 'internal' });
  assert.equal(h.unread(), read + 1);
});

test('an external agent is never the person: its message keeps a background turn internal, a bridged contact\'s does not (C8)', async () => {
  const h = taskSetup();
  h.state.script = async () => ({ text: 'Noted, still rendering.', stop: 'done' });
  h.chats.markRead(h.chat.id, h.tom.id, h.chats.messages(h.chat.id).at(-1)!.seq); // Tom has read the task message
  const heard = (authorId: string) => {
    h.chats.send({ conversationId: h.chat.id, authorId, authorKind: 'external', body: 'Please hurry up.' });
    h.context.delta = () => ({ text: 'Please hurry up.', images: [], lastSeq: h.chats.messages(h.chat.id).at(-1)!.seq });
    return h.run('retry');
  };
  await heard('ext:api:0123456789:Research-Bot');
  assert.equal(h.posts(), 0, 'an external agent does not make the turn awaited');
  assert.equal(h.answers().at(-1)?.visibility, 'internal');
  await heard('ext:tg:42:Sam (Telegram)');
  assert.equal(h.last().silent, false, 'a bridged contact does');
  assert.equal(h.answers().at(-1)?.visibility, 'notify');
});

test('a background turn that asks the person through human.ask (no taskId) is posted; a failed ask stays internal (regression)', async () => {
  const h = taskSetup();
  let output: ToolOutput = { content: [{ type: 'text', text: '{"ok":true,"todoId":"tsk_1"}' }] };
  Object.assign(h.services.tools, { get: () => ({ category: 'think' }), call: async () => output });
  h.state.script = async (input) => {
    await input.callTool('human.ask', { title: 'Send me the 2FA code', reason: 'credential', widget: { type: 'form' } }, 'call_ask');
    return { text: 'I need your code to continue – it is on your list.', stop: 'done' };
  };
  const before = h.unread();
  await h.run('retry');
  assert.equal(h.last().silent, false, 'the explanation of the new to-do reaches the person');
  assert.equal(h.unread(), before + 1);

  output = { content: [{ type: 'text', text: 'widget.type must be one of: choice, form' }], isError: true };
  const posted = h.posts();
  await h.run('retry');
  assert.equal(h.posts(), posted, 'no to-do was created: nothing to see');
  assert.equal(h.unread(), before + 1);
});

test('a retry turn keeps its text in the run log: no message (its silent live row goes), no unread, wakes nobody; the person\'s message turn is loud', async () => {
  const h = taskSetup();
  const created: string[] = [];
  h.bus.on('message.created', (message) => { if (message.authorId === h.tom.id) created.push(`${message.state}${message.silent ? ' silent' : ''}`); });
  h.state.script = async () => ({ text: 'Checked the export settings, still rendering.', stop: 'done' });
  const before = h.unread();
  await h.run('retry');
  assert.equal(h.posts(), 0);
  assert.deepEqual(created, ['streaming silent'], 'B-075: only its silent live row');
  assert.equal(h.chats.messages(h.chat.id).filter((message) => message.authorId === h.tom.id && message.kind === 'text').length, 0, 'removed at the end');
  assert.deepEqual(h.answers().at(-1), { answer: true, text: 'Checked the export settings, still rendering.', visibility: 'internal' });
  assert.equal(h.unread(), before, 'no unread for the person');
  assert.equal(h.wakesFor(h.mara.id).length, 0, 'nobody is woken');

  h.chats.send({ conversationId: h.chat.id, authorId: HUMAN_ID, body: 'Show me the first cut' });
  const asked = h.unread();
  h.state.script = async () => ({ text: 'Here is the first cut.', stop: 'done' });
  await h.run('message');
  assert.equal(h.last().silent, false);
  assert.equal(h.unread(), asked + 1);
  assert.deepEqual(created, ['streaming silent', 'streaming'], 'the awaited turn streams into its placeholder');
});

test('a background turn that mentions a colleague posts quietly and reaches them; tags work on any turn; a finished task is no chat news', async () => {
  const h = taskSetup();
  h.state.script = async () => ({ text: '@Mara can you check the colour grade?', stop: 'done' });
  const notified = h.notified.length;
  await h.run('retry');
  assert.equal(h.last().silent, true, 'posted quietly');
  assert.equal(h.wakesFor(h.mara.id).length, 1, 'Mara is woken all the same');
  assert.equal(h.notified.length, notified, 'the person is not notified');

  h.chats.send({ conversationId: h.chat.id, authorId: HUMAN_ID, body: 'Any news?' });
  h.context.delta = () => ({ text: 'You: Any news?', images: [], lastSeq: h.chats.messages(h.chat.id).at(-1)!.seq }); // Tom's cursor follows the chat
  h.state.script = async () => ({ text: 'Thinking out loud. [[silent]]', stop: 'done' });
  await h.run('message');
  assert.equal(h.last().silent, true, '[[silent]] on a turn the person waits for');
  assert.equal(h.last().body, 'Thinking out loud.');

  h.state.script = async () => ({ text: 'Rendering is slow today. [[notify]]', stop: 'done' });
  await h.run('schedule');
  assert.equal(h.last().body, 'Rendering is slow today.');
  assert.equal(h.last().silent, false, '[[notify]] posts a background text loudly');

  const posted = h.posts();
  h.state.script = async () => {
    h.tasks.complete(h.task.id, { summary: 'Intro cut to 12 s', evidence: [{ kind: 'file', label: 'intro.mp4' }], verification: 'claimed_by_agent' }, h.tom.id);
    return { text: 'Done: the intro is 12 seconds now.', stop: 'done' };
  };
  await h.run('review');
  assert.equal(h.posts(), posted, 'the answer stays in the run log');
  assert.ok(h.chats.messages(h.chat.id).some((message) => message.kind === 'status' && message.body === 'Done: Cut the intro'), 'the Done line says it');
  assert.equal(h.notified.filter((item) => item.kind === 'done').length, 1, 'and the person hears it once');
});

test('tasks.complete notify:false finishes quietly: the Done line stays, no done notification (B-047 D4)', () => {
  const h = taskSetup();
  h.services.tasks.complete(h.task.id, { summary: 'Intro cut to 12 s', evidence: [{ kind: 'file', label: 'intro.mp4' }], verification: 'claimed_by_agent', notify: false }, h.tom.id); // the contract (tasks.complete's path)
  assert.equal(h.tasks.get(h.task.id)?.status, 'done');
  assert.ok(h.chats.messages(h.chat.id).some((message) => message.kind === 'status' && message.body === 'Done: Cut the intro'));
  assert.equal(h.notified.filter((item) => item.kind === 'done').length, 0);
  assert.equal((h.tasks.get(h.task.id)?.result as Record<string, unknown> | undefined)?.notify, undefined, 'the flag is never stored');
});

test('an outage leaves no failed bubble, only one quiet line while it lasts', async () => {
  const h = taskSetup();
  h.state.script = async () => ({ text: '', stop: 'error', error: { code: 'unavailable', message: 'Claude Code is not signed in.' } });
  await h.run('retry');
  await h.run('retry');
  const messages = h.chats.messages(h.chat.id);
  assert.equal(messages.filter((message) => message.authorId === h.tom.id && message.state === 'failed').length, 0, 'no failed bubbles');
  const lines = messages.filter((message) => message.kind === 'status' && message.meta.status?.details?.outage === true);
  assert.equal(lines.length, 1, 'one line for the whole outage');
  assert.match(lines[0].body, /^Paused: Claude Code is not signed in\. – continues by itself$/);
  assert.equal(lines[0].silent, true);
});

test('B-047 D4: a background outage after some text (no placeholder) keeps the text in the run journal and still gets its line (regression)', async () => {
  const h = taskSetup();
  h.state.script = async (input) => {
    input.onEvent({ type: 'text', delta: 'Rendering the second cut' });
    return { text: '', stop: 'error', error: { code: 'unavailable', message: 'Claude Code is not signed in.' } };
  };
  await h.run('retry');
  assert.equal(h.posts(), 0, 'no failed bubble');
  assert.deepEqual(h.answers().at(-1), { answer: true, text: 'Rendering the second cut', visibility: 'internal' });
  const lines = h.chats.messages(h.chat.id).filter((message) => message.kind === 'status' && message.meta.status?.details?.outage === true);
  assert.equal(lines.length, 1, 'the person still learns the work is paused');
});
