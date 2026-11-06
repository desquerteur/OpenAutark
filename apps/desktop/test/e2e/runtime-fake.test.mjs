// End-to-end: the real headless runtime (built app/runtime-cli.mjs) with the deterministic fake
// engine, driven over the real WebSocket RPC – the same path the PWA and phone use.
// Covers: seed manager, model catalog, chat → agent reply (streaming → final), an agent tool call
// creating a task, an agent ask block marked "todo": true or important (B-078 D9: plain blocks stay quick replies)
// becoming a human to-do with the right widget, the human's
// answer completing the to-do and waking the agent with the person's own line (B-076; F06: the recording attached
// to that line and its stored path in the woken input), the person declining a to-do ("Can't do
// this…", F06: cancelled, the agent woken with their line "I can't do this: <reason>"), an agent's mini-app to-do
// (```app todo=true, F01) reaching the For-you list and finishing through blocks.answer (what its
// wf.complete sends) with the line "Done in mini-app" and its data, a free-text to-do as a plain Done (no guessing), schedules,
// knowledge, an agent's own task getting a quiet turn of its own with its continuations bounded (tasks/ownership.ts: a
// text-only echo turn did nothing, so the next waits a minute – never a 1-second loop; B-047 D4: its answer stays in
// the run journal; B-075: its silent live row goes at its end), and a clean shutdown.
// Run: npm run build && node --test test/e2e/runtime-fake.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { startRuntime } from './lib/runtime-client.mjs';

const CONTINUATION_WINDOW_MS = 30_000;
// Text-only turns: the own-task turn and one 1 s continuation count as progress, then stalls back
// off (10 s, 20 s …) – about 4 turns in 30 s. A 1-second loop would make about 30.
const MAX_TURNS_IN_WINDOW = 6;

const finalFrom = (chatId, agentId, pattern) => (message) =>
  message.conversationId === chatId && message.authorId === agentId && message.state === 'final' && (!pattern || pattern.test(message.body));

test('agent OS end-to-end over WebSocket RPC with the fake engine', { timeout: 300_000 }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  await client.call('events.subscribe', { topics: ['chats', 'tasks', 'org', 'system'] });

  const info = await client.call('system.info');
  assert.ok(info.version && info.deviceId, 'system.info answers');

  const agents = await client.call('agents.list');
  const manager = agents.find((agent) => agent.template === 'manager') ?? agents[0];
  assert.ok(manager, 'the first run seeds exactly one manager');

  // Demo mode seeds one account served by the deterministic fake engine; real logins stay unused.
  const accounts = await client.call('accounts.list');
  assert.deepEqual(accounts.map((account) => account.provider), ['compatible'], 'no real account in demo mode');
  const models = await client.call('models.list', { refresh: true });
  assert.ok(models.some((model) => model.engine === 'fake' && model.available), 'the fake engine is routable');

  const chat = await client.call('chats.create', { title: 'Launch', agentIds: [manager.id] });
  await client.call('events.subscribe', { topics: [`chat:${chat.id}`] });

  await t.test('plain message → streamed agent reply', async () => {
    await client.call('messages.send', { conversationId: chat.id, body: 'Hello team', clientId: 'e2e-1' });
    const reply = await client.waitFor('message.updated', finalFrom(chat.id, manager.id, /Echo: /), 90_000);
    assert.match(reply.body, /Hello team/);
  });

  await t.test('agent tool call creates a task anchored in the chat', async () => {
    await client.call('messages.send', { conversationId: chat.id, body: 'Plan it [[tool:tasks.create {"title":"Draft launch plan"}]]' });
    const task = await client.waitFor('task.upserted', (item) => item.title === 'Draft launch plan', 90_000);
    assert.equal(task.conversationId, chat.id);
    const tasks = await client.call('tasks.list', { conversationId: chat.id });
    assert.ok(tasks.some((item) => item.id === task.id));
  });

  await t.test('ask block → human to-do → answer → agent woken with the person\'s line', async () => {
    await client.call('messages.send', { conversationId: chat.id, body: 'Need your voice [[ui:{"type":"record","mode":"audio","script":"Hi there","todo":true}]]' });
    const todo = await client.waitFor('task.upserted', (item) => item.assigneeKind === 'human' && item.widget?.type === 'record', 90_000);
    const todos = await client.call('todos.list');
    assert.ok(todos.some((item) => item.id === todo.id), 'the to-do is on the For-you list');
    const file = await client.call('files.upload', { name: 'voice.webm', mime: 'audio/webm', dataBase64: Buffer.from('fake audio').toString('base64') });
    await client.call('tasks.complete', { id: todo.id, answer: { file: file.id, seconds: 3, mime: 'audio/webm' }, clientId: 'e2e-answer' });
    await client.waitFor('task.upserted', (item) => item.id === todo.id && item.status === 'done', 30_000);
    // F06: the recording reaches the agent – B-076: as the person's line, which names where it is stored.
    const woken = await client.waitFor('message.updated', finalFrom(chat.id, manager.id, /Recorded 0:03/), 90_000);
    assert.match(woken.body, /\[Audio: voice\.webm\] \([^\n]*stored at /, 'the woken input names the stored recording with its path');
    assert.doesNotMatch(woken.body, /ui-answer/);
    const messages = await client.call('messages.list', { conversationId: chat.id, limit: 50 });
    const receipt = messages.find((message) => message.kind === 'answer' && message.taskId === todo.id);
    assert.deepEqual(receipt?.attachments.map((attachment) => attachment.fileId), [file.id], 'the receipt carries the recording');
  });

  await t.test("the person declines a to-do (\"Can't do this…\") → cancelled → agent woken with the reason", async () => {
    await client.call('messages.send', { conversationId: chat.id, body: 'Plug it in [[ui:{"type":"confirm","instructions":"Plug in the camera","important":true}]]' });
    const todo = await client.waitFor('task.upserted', (item) => item.assigneeKind === 'human' && item.widget?.type === 'confirm', 90_000);
    const declined = await client.call('todos.decline', { id: todo.id, reason: 'No camera here', clientId: 'e2e-decline' });
    assert.equal(declined.status, 'cancelled');
    assert.deepEqual(declined.result?.answer, { declined: true, reason: 'No camera here' });
    assert.ok(!(await client.call('todos.list')).some((item) => item.id === todo.id), 'the to-do left the list');
    const woken = await client.waitFor('message.updated', finalFrom(chat.id, manager.id, /I can't do this: No camera here/), 90_000);
    assert.doesNotMatch(woken.body, /ui-answer/);
  });

  await t.test('agent mini-app (```app todo=true) → For-you to-do → blocks.answer → done', async () => {
    const html = '<button onclick="wf.complete({take:1})">Done</button>';
    await client.call('messages.send', { conversationId: chat.id, body: `Your take [[app:title="Voice take" todo=true reason=physical permissions="microphone"|${html}]]` });
    const todo = await client.waitFor('task.upserted', (item) => item.assigneeKind === 'human' && item.widget?.type === 'app', 90_000);
    assert.equal(todo.title, 'Voice take');
    assert.equal(todo.humanReason, 'physical');
    assert.deepEqual(todo.widget.permissions, ['microphone']);
    assert.equal(todo.messageId, todo.widget.messageId, 'anchored to the agent message that holds the app');
    const todos = await client.call('todos.list');
    assert.ok(todos.some((item) => item.id === todo.id), 'the mini-app is on the For-you list');
    const { html: served } = await client.call('blocks.appHtml', { messageId: todo.widget.messageId, blockIndex: todo.widget.index });
    assert.equal(served, html, 'the list renders the app from its message');
    // What the app's wf.complete(data) sends (ui/blocks/AppFrame.tsx).
    const answered = await client.call('blocks.answer', { messageId: todo.widget.messageId, blockIndex: todo.widget.index, answer: { take: 1 }, clientId: 'app:e2e' });
    assert.equal(answered.taskId, todo.id);
    const done = await client.waitFor('task.upserted', (item) => item.id === todo.id && item.status === 'done', 30_000);
    assert.equal(done.result?.summary, 'Done in mini-app · take: 1');
    assert.ok(!(await client.call('todos.list')).some((item) => item.id === todo.id), 'the to-do left the list');
    await client.waitFor('message.updated', finalFrom(chat.id, manager.id, /Done in mini-app\ntake: 1/), 90_000);
  });

  await t.test('a free-text to-do is a plain Done – no guessing of widgets or times (tasks/todo-draft.ts)', async () => {
    const reminder = await client.call('todos.add', { text: 'Remind me at 17:00 to call the bank' });
    assert.equal(reminder.widget?.type, 'confirm');
    assert.equal(reminder.assigneeKind, 'human');
    const recording = await client.call('todos.add', { text: 'Record the intro video for the course' });
    assert.equal(recording.widget?.type, 'confirm', 'another widget is picked with "Show as…" or by an agent');
  });

  await t.test('agent self-reminder becomes a visible schedule', async () => {
    await client.call('messages.send', { conversationId: chat.id, body: 'Follow up [[tool:schedules.remind {"note":"Check comments","when":{"once":"PT2H"}}]]' });
    await client.waitFor('message.updated', finalFrom(chat.id, manager.id, /schedules\.remind/), 90_000);
    const schedules = await client.call('schedules.list', { ownerId: manager.id });
    assert.ok(schedules.length >= 1, 'the reminder is listed');
  });

  await t.test('knowledge round trip', async () => {
    const item = await client.call('knowledge.save', { title: 'Brand color', body: 'Our brand color is teal.', scope: 'global', kind: 'fact' });
    const hits = await client.call('knowledge.search', { text: 'brand color', limit: 3 });
    assert.ok(hits.some((hit) => hit.item.id === item.id));
  });

  await t.test('an own task gets a quiet turn of its own; its continuations stay bounded', { timeout: 150_000 }, async () => {
    const own = await client.call('chats.create', { title: 'Stickers', agentIds: [manager.id] });
    await client.call('events.subscribe', { topics: [`chat:${own.id}`, `runs:${manager.id}`] });
    await client.call('messages.send', {
      conversationId: own.id, body: 'Later [[tool:tasks.create {"title":"Compare sticker printers","doneWhen":"Three printers compared"}]]',
    });
    const task = await client.waitFor('task.upserted', (item) => item.title === 'Compare sticker printers', 90_000);
    assert.equal(task.assigneeId, manager.id, 'tasks.create defaults to the creating agent');
    try {
      const first = await client.waitFor('run.upserted', (run) => run.taskId === task.id && run.startedAt !== undefined, 90_000);
      // B-047 D4 (agents/publishing.ts): a background turn keeps its answer in the run journal, the chat gets nothing.
      await client.waitFor('run.upserted', (run) => run.id === first.id && run.endedAt !== undefined, 60_000);
      const answer = (await client.call('runs.items', { runId: first.id })).find((item) => item.kind === 'note' && item.name === 'Answer');
      assert.equal(answer?.data.visibility, 'internal', 'a background turn keeps its answer internal');
      // B-075 (agents/turn.ts, agents/turn-finish.ts): its work showed in a silent live row without text that went at its end.
      const rows = client.events.filter((frame) => frame.event.startsWith('message.') && frame.data.runId === first.id).map((frame) => frame.data);
      assert.ok(rows.every((row) => row.silent === true && row.state === 'streaming' && !row.body), 'its live row stays silent and holds no text');
      assert.ok(rows.every((row) => client.events.some((frame) => frame.event === 'message.removed' && frame.data.id === row.id)), 'its live row went at its end');
      const lines = await client.call('messages.list', { conversationId: own.id, limit: 100 });
      assert.ok(!lines.some((message) => message.runId === first.id), 'and posts no chat line');
      // tasks/ownership.ts: a text-only turn did nothing, so the next one waits a minute (doubling) – never a 1-second loop
      const windowEnd = first.startedAt + CONTINUATION_WINDOW_MS;
      await sleep(Math.max(0, windowEnd - Date.now()) + 500);
      const turns = new Set(client.events
        .filter((frame) => frame.event === 'run.upserted' && frame.data.taskId === task.id && (frame.data.startedAt ?? Infinity) <= windowEnd)
        .map((frame) => frame.data.id)).size;
      assert.ok(turns >= 1, `the own task got its turn (${turns})`);
      assert.ok(turns <= MAX_TURNS_IN_WINDOW, `${turns} turns on the task within 30 s – continuations must back off`);
    } finally {
      await client.call('tasks.setStatus', { id: task.id, status: 'cancelled' }); // the echo would keep re-checking it
    }
  });
});
