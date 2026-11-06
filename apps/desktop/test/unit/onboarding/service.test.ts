// First run, runtime side (runtime/onboarding/service.ts, brief.ts): start() ends the layer – step 'done'
// and completed, the Manager's first chat (made when there is none) and the app's start text there as the person's
// line (the shipped resources/prompts/onboarding.md, or the fallback), which wakes the Manager as an ordinary
// message; reset() opens the layer again at 'ai'. The line's own cases: start-line.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Onboarding } from '../../../src/runtime/onboarding/service.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { agent, harness } from '../chat/harness.ts';

const RESOURCES = path.resolve(import.meta.dirname, '../../../resources');

function setup(options: { prompts?: boolean } = {}) {
  const h = harness();
  const settings = new SettingsStore({ db: h.db, bus: h.bus, clock: h.clock, env: { locale: 'en-US', timezone: 'UTC' } });
  Object.assign(h.services, {
    settings,
    accounts: { list: () => [], detect: async () => ({}) },
    ...(options.prompts ? { prompts: new PromptTemplates(() => path.join(RESOURCES, 'prompts')) } : {}),
  });
  const services = h.services as RuntimeServices;
  const make = () => new Onboarding({ services: () => services });
  return { ...h, services, settings, make };
}

/** Passive or holding-back wording the start text must never carry. */
const PASSIVE = /facts only|no steps|not ahead of it|never change|approval|permission mode/i;
/** The person's lines in a chat. */
const ownLines = (h: ReturnType<typeof setup>, conversationId: string) => h.chats.messages(conversationId).filter((message) => message.authorId === HUMAN_ID);

test('start(): step done and completed, the Manager\'s first chat, the start text as the person\'s line and one message wake – also when asked twice', () => {
  const h = setup({ prompts: true });
  const onboarding = h.make();
  assert.equal(h.settings.get().onboarding.step, 'tour', 'a new install starts with the feedback tour');
  const manager = h.org.add(agent('ag_boss', 'Manager', { mode: 'manager', template: 'manager', createdAt: 1 }));
  h.settings.update({ profile: { name: 'Lena Hess', company: '' } });

  const { conversationId } = onboarding.start();
  const chat = h.chats.list().find((entry) => entry.id === conversationId);
  assert.ok(chat, 'a chat with the Manager was made (there was none)');
  assert.deepEqual(chat.members.filter((member) => member.kind === 'agent').map((member) => member.memberId), [manager.id]);
  assert.deepEqual(h.settings.get().onboarding, { completed: true, step: 'done' }, 'the first run completes the onboarding itself');

  assert.equal(h.wakeRows().filter((row) => row.reason === 'setup').length, 0, 'no setup wake');
  const rows = h.wakeRows().filter((row) => row.reason === 'message');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent_id, manager.id);
  assert.equal(rows[0].conversation_id, conversationId);
  const [line] = ownLines(h, conversationId);
  assert.match(line.body, /^Automatic message from the app, not typed by me: I just installed Autark, entered Lena Hess and clicked Start\./, 'an empty company leaves no gap');
  assert.match(line.body, /How you go about it is your call\./, 'B-076: the way is the agent\'s');
  assert.match(line.body, /Please set this up for me – you are my personal manager, my right hand\. Get to know me first: talk with me/, 'B-078: the personal manager starts with the person');
  assert.match(line.body, /a head for each area my work really has[^.]*\. For parallel work you split yourself \(Ultra\) instead of hiring many agents\./);
  assert.match(line.body, /the passwords saved in my browsers belong in the secrets catalog \(exported and imported unread\)/);
  assert.match(line.body, /the models you run on now – for the work, for decisions, for search by meaning – can likely be better/);
  assert.doesNotMatch(line.body, /First ask me|before you start|how far you go|belongs in your memory|Write to me in|German|English/, 'B-076: no "ask me first", nothing to store as a permission, no language order');
  assert.equal(line.body.split('\n').length, 1, 'one line');
  assert.equal(PASSIVE.test(line.body), false, `no passive or holding-back line: ${line.body}`);
  assert.equal(/\{\{|<!--/.test(line.body), false, 'no placeholder or maintainer note left');

  assert.deepEqual(onboarding.start(), { conversationId }, 'the same chat again');
  assert.equal(ownLines(h, conversationId).length, 1, 'not posted twice');
  assert.equal(h.wakeRows().filter((row) => row.reason === 'message').length, 1, 'no second wake while one waits');
});

test('start() uses the Manager\'s existing first chat and refuses without a Manager; without the prompt templates the fallback text', () => {
  const h = setup();
  const onboarding = h.make();
  assert.throws(() => onboarding.start(), /no Manager/);
  const manager = h.org.add(agent('ag_boss', 'Manager', { mode: 'manager', createdAt: 1 }));
  const first = h.chats.create({ title: 'Manager', agentIds: [manager.id], createdBy: 'human' });
  assert.equal(onboarding.start().conversationId, first.id);
  const [line] = ownLines(h, first.id);
  assert.match(line.body, /^Automatic message from the app, .* entered no name and clicked Start\./, 'without the prompt templates the fallback text');
  assert.equal(PASSIVE.test(line.body), false, line.body);
});

test('reset(): the layer is open again at the first card; start() closes it again', () => {
  const h = setup();
  const onboarding = h.make();
  h.org.add(agent('ag_boss', 'Manager', { mode: 'manager', createdAt: 1 }));
  onboarding.start();
  assert.deepEqual(h.settings.get().onboarding, { completed: true, step: 'done' });
  onboarding.reset();
  assert.deepEqual(h.settings.get().onboarding, { completed: false, step: 'ai' });
  onboarding.start();
  assert.deepEqual(h.settings.get().onboarding, { completed: true, step: 'done' });
});
