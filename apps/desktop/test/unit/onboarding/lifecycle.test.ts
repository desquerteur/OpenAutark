// Onboarding lifecycle against the real RPC server, settings, chat service and skill library: the built-in
// team-building skill (org-setup-onboarding) never retires – it stays in the manager's index before and after
// the first run; onboarding.reset (owner only) opens the setup assistant again at step 'profile'; onboarding.start
// (owner only) ends the layer, completes the onboarding and posts the start text, which wakes the Manager.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { agent } from '../chat/harness.ts';
import { OWNER, PHONE, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';
import { HandlerTable } from '../../../src/runtime/rpc/table.ts';
import { register as registerChats } from '../../../src/runtime/rpc/handlers/chats.ts';
import { register as registerApp } from '../../../src/runtime/rpc/handlers/app.ts';
import { Onboarding } from '../../../src/runtime/onboarding/service.ts';
import { SkillLibrary } from '../../../src/runtime/skills/service.ts';
import { parseFrontMatter } from '../../../src/runtime/skills/frontmatter.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';

const RESOURCES = path.resolve(import.meta.dirname, '../../../resources');
const SKILL = 'org-setup-onboarding';
const MANAGER_MODE = { key: 'manager', skills: [SKILL] } as unknown as ModeInfo;

function setup() {
  const table = new HandlerTable();
  registerChats(table);
  registerApp(table);
  const f = rpcFixture({ table });
  const skills = new SkillLibrary({ paths: { workspace: f.paths.workspace, resources: RESOURCES }, clock: f.clock, home: '' });
  const onboarding = new Onboarding({ services: () => f.services });
  Object.assign(f.extras, { onboarding });
  const boss = f.org.add(agent('ag_boss', 'Boss', { mode: 'manager', template: 'manager' }));
  const owner = new TestClient(f.server, OWNER);
  const phone = new TestClient(f.server, PHONE);
  const indexed = (mode: ModeInfo) => skills.indexFor(boss, mode).map((info) => info.name);
  return { ...f, skills, onboarding, boss, owner, phone, indexed };
}

/** The first-run part of the onboarding section (the tour's keys beside it have their own tests, AF-002). */
const stepOf = (o: { completed: boolean; step: string }) => ({ completed: o.completed, step: o.step });

test('the team-building skill stays in the manager index before and after the first run and a reset; reset is owner only', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  assert.ok(f.indexed(MANAGER_MODE).includes(SKILL), 'listed by the manager mode');
  await f.owner.call('onboarding.start');
  assert.equal(f.services.settings.get().onboarding.completed, true);
  assert.ok(f.indexed(MANAGER_MODE).includes(SKILL), 'no retirement: team building goes on after the first run');
  assert.match(f.skills.get(SKILL)?.body ?? '', /# Building and keeping a clean agent organisation/, 'loadable by name');
  assert.doesNotMatch(f.skills.get(SKILL)?.body ?? '', /set everything up/i, 'D5: tool facts, no setup recipe');

  assert.equal((await f.phone.request('onboarding.reset')).error?.code, 'forbidden', 'owner only');
  assert.equal(f.services.settings.get().onboarding.completed, true);
  assert.deepEqual(await f.owner.call('onboarding.reset'), { ok: true });
  assert.deepEqual(stepOf(f.services.settings.get().onboarding), { completed: false, step: 'profile' });
  assert.ok(f.indexed(MANAGER_MODE).includes(SKILL));
});

test("onboarding.start (owner only): step done, the Manager's chat and a message wake there; a phone cannot", async (t) => {
  const f = setup();
  t.after(f.cleanup);
  assert.equal((await f.phone.request('onboarding.start')).error?.code, 'forbidden', 'owner only');
  assert.equal((await f.owner.request('onboarding.start', { chat: 'x' })).error?.code, 'bad_request');
  const { conversationId } = await f.owner.call<{ conversationId: string }>('onboarding.start');
  assert.ok(f.chats.get(conversationId), "the Manager's first chat");
  assert.deepEqual(stepOf(f.services.settings.get().onboarding), { completed: true, step: 'done' }, 'start completes the onboarding');
  const wake = f.wakeRows().find((row) => row.reason === 'message');
  assert.equal(wake?.agent_id, f.boss.id);
  assert.equal(wake?.conversation_id, conversationId);
  assert.ok(f.indexed(MANAGER_MODE).includes(SKILL), 'the team-building skill stays');
  assert.equal((await f.owner.request('messages.send', { conversationId, body: 'x', via: 'suggestion' })).error?.code, 'bad_request', 'the setup draft origin is gone');
});

test('the shipped skill: no retirement, no interview procedure, no consent gate, no held-back lines, no setup recipe – tool facts', () => {
  const shipped = parseFrontMatter(readFileSync(path.join(RESOURCES, 'skills', SKILL, 'SKILL.md'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(shipped.data), /until/, 'the shipped team-building skill never retires');
  assert.doesNotMatch(shipped.body, /max 3 questions|three questions|explicit grant|permission\.offer|onboarding\.complete/i, 'no interview procedure, no consent gate on the PC');
  assert.doesNotMatch(shipped.body, /not ahead of it|never change|permission mode|one approval|enforces them/i, 'no held-back lines');
  assert.doesNotMatch(`${shipped.data.description} ${shipped.body}`, /set everything up|research the person|report once/i, 'D5: no recipe for a kind of request');
  for (const route of ['agents.templates', 'agents.create', 'agents.update', 'agents.archive']) assert.ok(shipped.body.includes(`\`${route}\``), route);
});
