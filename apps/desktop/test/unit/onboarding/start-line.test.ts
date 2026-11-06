// The app's start text (runtime/onboarding/service.ts start(), brief.ts, resources/prompts/onboarding.md, the
// onboarding.start RPC in rpc/handlers/app.ts): Start posts one fixed line in the Manager's first chat as the
// person's own (HUMAN_ID), addressed to the Manager; from there on it is an ordinary message – one 'message' wake,
// exactly one Manager turn, routed as a person's request. No note, no setup wake; onboarding.start takes no params.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Onboarding } from '../../../src/runtime/onboarding/service.ts';
import { BRIEF_MAX, setupBrief } from '../../../src/runtime/onboarding/brief.ts';
import { groupWakes } from '../../../src/runtime/agents/dispatch-groups.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { personAsks } from '../../../src/runtime/routing/person-turn.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { HandlerTable } from '../../../src/runtime/rpc/table.ts';
import { register as registerChats } from '../../../src/runtime/rpc/handlers/chats.ts';
import { register as registerApp } from '../../../src/runtime/rpc/handlers/app.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { HUMAN_WROTE_NOTE } from '../../../src/runtime/tasks/transitions.ts';
import { agent, harness } from '../chat/harness.ts';
import { flush, setup as dispatcherSetup } from '../dispatcher/fakes.ts';
import { OWNER, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';

const RESOURCES = path.resolve(import.meta.dirname, '../../../resources');
const LENA = 'Automatic message from the app, not typed by me: I just installed Autark, entered Lena Hess and Hess GmbH and clicked Start. Please set this up for me – you are my personal manager, my right hand. Get to know me first: talk with me, read what is on this PC and on the web about me, my earlier conversations with other AIs (ChatGPT, Claude and others, in their apps or in my browser) and the memories they keep about me, and see how I work. Then build the structure that fits: a head for each area my work really has (for example programming or social media), each set up like you and working beside you, while you stay my personal contact. For parallel work you split yourself (Ultra) instead of hiring many agents. Which language we work in you find out with me – this PC\'s is a first guess. How you go about it is your call. Set yourself up on the way: the passwords saved in my browsers belong in the secrets catalog (exported and imported unread), so you and I can fill logins everywhere, and the models you run on now – for the work, for decisions, for search by meaning – can likely be better: you will see what a real decision model and a real search model would change for me and what I already have for them (my keys and plans, a model this PC can run, a provider\'s offer).';

/** The chat harness (real chats, delivery, wakes) with real settings and the shipped prompts – as service.test.ts. */
function withServices<H extends ReturnType<typeof harness>>(h: H) {
  const settings = new SettingsStore({ db: h.db, bus: h.bus, clock: h.clock, env: { locale: 'en-US', timezone: 'UTC' } });
  Object.assign(h.services, {
    settings, accounts: { list: () => [], detect: async () => ({}) },
    prompts: new PromptTemplates(() => path.join(RESOURCES, 'prompts')),
  });
  const services = h.services as RuntimeServices;
  const manager = h.org.add(agent('ag_boss', 'Manager', { mode: 'manager', template: 'manager', createdAt: 1 }));
  settings.update({ profile: { name: 'Lena Hess', company: 'Hess GmbH', language: 'de' } });
  return { ...h, services, settings, manager, onboarding: new Onboarding({ services: () => services }) };
}

test("start(): the fixed line as the person's own, addressed to the Manager, one 'message' wake with no note, one turn group", () => {
  const h = withServices(harness());
  const { conversationId } = h.onboarding.start();

  const lines = h.chats.messages(conversationId).filter((message) => message.kind === 'text');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].authorId, HUMAN_ID, "the owner's own message");
  assert.equal(lines[0].authorKind, 'human');
  assert.equal(lines[0].body, LENA);
  assert.equal(lines[0].silent, false);
  assert.deepEqual(lines[0].mentions, [h.manager.id]);

  const rows = h.wakeRows().filter((row) => row.agent_id === h.manager.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].conversation_id, conversationId);
  assert.equal(rows[0].reason, 'message', 'an ordinary message, no setup wake');
  assert.equal(rows[0].note, null, 'no separate note');
  assert.equal(personAsks(h.services, { agent: h.manager, conversationId }), true, "routed as a person's request: the strongest model");

  assert.equal(groupWakes(h.wakes.claim(h.manager.id)).length, 1, 'one claim, one group: one turn');
  assert.deepEqual(h.settings.get().onboarding, { completed: true, step: 'done' });
});

test('asked twice: one line, one wake; after "Set up team again" with an answer in between, a new line', () => {
  const h = withServices(harness());
  const first = h.onboarding.start();
  assert.deepEqual(h.onboarding.start(), first, 'the same chat again');
  const own = () => h.chats.messages(first.conversationId).filter((message) => message.authorId === HUMAN_ID);
  assert.equal(own().length, 1, 'never posted twice');
  assert.equal(h.wakeRows().filter((row) => row.agent_id === h.manager.id).length, 1);

  h.chats.send({ conversationId: first.conversationId, body: 'Hello Lena', authorId: h.manager.id });
  h.onboarding.reset();
  h.onboarding.start();
  assert.equal(own().length, 2, 'the Manager answered: the start text is the newest line again');
});

test('the line reads plainly with what was entered: empty company, empty name, both empty', () => {
  const h = withServices(harness());
  const entered = () => /I just installed Autark, entered (.*?) and clicked Start\./.exec(setupBrief(h.services))?.[1];
  assert.equal(entered(), 'Lena Hess and Hess GmbH');
  h.settings.update({ profile: { company: '' } });
  assert.equal(entered(), 'Lena Hess');
  h.settings.update({ profile: { name: '', company: 'Hess GmbH' } });
  assert.equal(entered(), 'no name and Hess GmbH');
  h.settings.update({ profile: { company: '' } });
  assert.equal(entered(), 'no name');
  assert.doesNotMatch(setupBrief(h.services), /\{\{|<!--|\u0000|  /, 'no placeholder, maintainer note or gap left');
});

test('the shipped file and the fallback are the same text; an own prompt replaces them and is cut when far too long', () => {
  const h = withServices(harness());
  const shipped = setupBrief(h.services);
  assert.equal(shipped, LENA);
  assert.ok(shipped.length < BRIEF_MAX, `the shipped text stays well under the cut: ${shipped.length}`);
  assert.equal(setupBrief({ ...h.services, prompts: undefined } as unknown as RuntimeServices), shipped, 'the fallback');
  assert.equal(setupBrief({ ...h.services, prompts: { text: () => { throw new Error('locked'); } } } as unknown as RuntimeServices), shipped, 'an unreadable prompt');
  const own = (text: string) => setupBrief({ ...h.services, prompts: { text: () => text } } as unknown as RuntimeServices);
  assert.equal(own('Hi from {{name}} of {{company}} in {{language}}'), 'Hi from Lena Hess of Hess GmbH in German');
  assert.equal(own(`${'y'.repeat(5000)} {{name}}`).length, BRIEF_MAX);
});

test('an own prompt that renders to nothing posts nothing and still ends the first run', () => {
  const h = withServices(harness());
  Object.assign(h.services, { prompts: { text: () => '{{#unknown}}never{{/unknown}}' } });
  const { conversationId } = h.onboarding.start();
  assert.equal(h.chats.messages(conversationId).filter((message) => message.authorId === HUMAN_ID).length, 0);
  assert.deepEqual(h.settings.get().onboarding, { completed: true, step: 'done' });
});

test('exactly ONE Manager turn: real dispatcher, delivery, wake queue and scheduler – the line is new in the chat, no notes', async () => {
  const h = withServices(dispatcherSetup());
  h.dispatcher.start();
  const { conversationId } = h.onboarding.start();
  await flush();
  assert.equal(h.executor.calls.length, 1, 'one turn');
  const turn = h.executor.last().request;
  assert.equal(turn.agentId, h.manager.id);
  assert.equal(turn.conversationId, conversationId);
  assert.equal(turn.reason, 'message');
  assert.deepEqual(turn.notes, []);
  const unseen = h.chats.messages(conversationId, { afterSeq: h.chats.members(conversationId).find((member) => member.memberId === h.manager.id)?.readSeq ?? 0 });
  assert.deepEqual(unseen.filter((message) => message.authorId === HUMAN_ID).map((message) => message.body), [LENA], 'the line is what the turn reads');
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.calls.length, 1, 'no second turn');
  assert.equal(h.wakeRows().length, 0, 'nothing left in the queue');
});

test('the Manager busy in another chat at Start: after that turn, exactly one turn for the line', async () => {
  const h = withServices(dispatcherSetup());
  h.org.add(agent('ag_two', 'Writer', { createdAt: 2 }));
  // A room with a second agent: not the Manager's first chat (shared/text/manager-chat.ts).
  const other = h.chats.create({ title: 'Other', agentIds: [h.manager.id, 'ag_two'], createdBy: 'human' });
  h.dispatcher.start();
  h.wakes.wake({ agentId: h.manager.id, reason: 'manual', conversationId: other.id });
  await flush();
  assert.equal(h.executor.calls.length, 1);
  h.clock.advance(1000);
  const { conversationId } = h.onboarding.start();
  assert.notEqual(conversationId, other.id);
  await flush();
  assert.equal(h.executor.calls.length, 1, 'one turn per agent at a time');
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.calls.length, 2);
  assert.equal(h.executor.last().request.conversationId, conversationId);
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.calls.length, 2, 'no further turn');
  assert.equal(h.wakeRows().length, 0);
});

test('"Set up team again" while a Manager task in that chat waits on the person: ONE wake and ONE turn, the message wake carries the task', async () => {
  const h = withServices(dispatcherSetup());
  const chat = h.chats.create({ agentIds: [h.manager.id], createdBy: 'human' }); // the Manager's first chat
  const task = h.tasks.create({ conversationId: chat.id, title: 'Book the venue', assigneeKind: 'agent', assigneeId: h.manager.id, createdBy: HUMAN_ID });
  h.tasks.setStatus(task.id, 'needs_you', h.manager.id, 'Which date?');
  h.wakes.done(h.wakes.claim(h.manager.id).map((wake) => wake.id)); // what the task itself queued is not this test's
  h.dispatcher.start();
  const { conversationId } = h.onboarding.start();
  assert.equal(conversationId, chat.id);
  const rows = h.wakeRows().filter((row) => row.agent_id === h.manager.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].task_id, task.id);
  assert.equal(rows[0].note, HUMAN_WROTE_NOTE);
  await flush();
  assert.equal(h.executor.calls.length, 1);
  assert.equal(h.executor.last().request.taskId, task.id);
  h.executor.last().finish();
  await flush();
  assert.equal(h.executor.calls.length, 1, 'no second Manager turn');
});

test('onboarding.start takes no params: any key is refused and starts nothing; the plain call posts the line', async (t) => {
  const table = new HandlerTable();
  registerChats(table);
  registerApp(table);
  const f = rpcFixture({ table });
  t.after(f.cleanup);
  const onboarding = new Onboarding({ services: () => f.services });
  Object.assign(f.extras, { onboarding });
  const boss = f.org.add(agent('ag_boss', 'Boss', { mode: 'manager', template: 'manager' }));
  const owner = new TestClient(f.server, OWNER);

  for (const params of [{ firstTask: 'Plan the launch' }, { chat: 'x' }]) {
    const response = await owner.request('onboarding.start', params);
    assert.equal(response.error?.code, 'bad_request', JSON.stringify(params));
  }
  assert.equal(f.wakeRows().length, 0, 'a refused call starts nothing');
  assert.equal(f.services.settings.get().onboarding.step, 'tour', 'still the first step (B-055 Q5: the tour)');

  const { conversationId } = await owner.call<{ conversationId: string }>('onboarding.start');
  const posted = f.chats.messages(conversationId).filter((message) => message.authorId === HUMAN_ID);
  assert.equal(posted.length, 1);
  assert.match(posted[0].body, /^Automatic message from the app, /);
  const rows = f.wakeRows().filter((row) => row.agent_id === boss.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'message');
  assert.deepEqual(f.services.settings.get().onboarding, { completed: true, step: 'done' });
});
