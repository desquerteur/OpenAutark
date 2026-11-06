// C7: stream ends and terminal safety of the wf terminal client, in-process against the fake
// runtime (fake-runtime.ts): --count n prints exactly n items even when more frames arrive in one
// burst, and human output never carries control characters or escape sequences from agents or
// external contacts to the terminal (--json stays lossless).
// Owns: these assertions only. Never: starts the real runtime or reads the person's app data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { message, task } from './fixtures.ts';
import { fakeRuntime, launch, manager, wf } from './fake-runtime.ts';

/** C0 controls except \n and \t, DEL and C1 – none may reach the terminal raw. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const HOSTILE = 'ok\u001b]52;c;cm0gLXJmIH4=\u0007\u001b[2K\rSent to Launch.\u009b2J';

test('--count n: a burst of more frames than n prints exactly n (events and watch, human and --json)', async (t) => {
  const topic = `chat:${launch.id}`;
  const runtime = await fakeRuntime({
    'events.subscribe': (params, fake) => {
      setTimeout(() => {
        const topics = (params as { topics: string[] }).topics;
        if (topics.includes('tasks')) for (let i = 0; i < 3; i++) fake.push('task.upserted', task({ id: `task_${i}`, title: `Step ${i}`, status: 'working' }), 'tasks');
        if (topics.includes(topic)) for (let i = 0; i < 3; i++) fake.push('message.created', message({ id: `msg_${i}`, seq: 10 + i, conversationId: launch.id, authorId: manager.id, authorKind: 'agent', body: `Reply ${i}` }), topic);
      }, 20);
      return { ok: true };
    },
  });
  t.after(() => runtime.stop());
  const json = await wf(['events', 'tasks', '--json', '--count', '1'], { runtime });
  assert.equal(json.code, 0, json.err);
  assert.deepEqual(json.out.trim().split('\n').map((line) => JSON.parse(line).data.id), ['task_0']);
  const human = await wf(['events', 'tasks', '--count', '2'], { runtime });
  assert.equal(human.code, 0, human.err);
  assert.equal(human.out.trim().split('\n').length, 2);
  const watched = await wf(['watch', 'Launch', '--count', '1'], { runtime });
  assert.equal(watched.code, 0, watched.err);
  assert.equal(watched.out, '14:02  Manager: Reply 0\n');
  const watchedJson = await wf(['watch', 'Launch', '--count', '2', '--json'], { runtime });
  assert.deepEqual(watchedJson.out.trim().split('\n').map((line) => JSON.parse(line).id), ['msg_0', 'msg_1']);
});

test('terminal safety: escape sequences, lone CR and C1 controls from agents or contacts are neutralised in human output', async (t) => {
  const topic = `chat:${launch.id}`;
  const hostile = message({ id: 'msg_x', seq: 9, conversationId: launch.id, authorId: 'ext_contact', authorKind: 'external', body: HOSTILE });
  const runtime = await fakeRuntime({
    'chats.list': () => [{ ...launch, lastPreview: { authorId: manager.id, text: HOSTILE, at: launch.createdAt } }],
    'messages.list': () => [hostile],
    'tasks.list': () => [task({ id: 'task_x', title: 'Plan\u001b[1A\u001b[2K', status: 'working' })],
    'events.subscribe': (_params, fake) => { setTimeout(() => fake.push('message.created', { ...hostile, id: 'msg_y', seq: 10 }, topic), 20); return { ok: true }; },
  });
  t.after(() => runtime.stop());
  for (const argv of [['chats'], ['read', 'Launch'], ['tasks'], ['watch', 'Launch', '--count', '1'], ['events', 'chat:launch', '--count', '1']]) {
    const result = await wf(argv, { runtime });
    assert.equal(result.code, 0, `${argv.join(' ')}: ${result.err}`);
    assert.ok(!CONTROL.test(result.out) && !CONTROL.test(result.err), `${argv.join(' ')} prints no control characters: ${JSON.stringify(result.out)}`);
    assert.match(result.out, /�/, `${argv.join(' ')} shows where something was removed`);
  }
  const read = await wf(['read', 'Launch'], { runtime });
  assert.match(read.out, /ext_contact: ok�\]52;c;cm0gLXJmIH4=��\[2K\n {7}Sent to Launch\.�2J\n$/, 'a lone CR starts a new, indented line instead of overwriting this one');

  const json = await wf(['read', 'Launch', '--json'], { runtime });
  assert.ok(!CONTROL.test(json.out), 'raw C1 controls are escaped in JSON as well');
  assert.equal(JSON.parse(json.out)[0].body, HOSTILE, '--json keeps the exact text');
});
