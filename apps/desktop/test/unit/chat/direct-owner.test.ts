// B-050 K1, Nachtrag Runde 4 ("Standardmäßig soll es mit jedem Agent zum Beispiel einen Chat geben"): the owner's
// default 1:1 with every active agent exists from the start (runtime/chat/direct.ts keepOwnerDirects, started by
// main.ts) – a hire gets it as the org announces it (sub-agents and an agent's own hires too), the start-up backfill
// makes the missing ones in one transaction (an older chat of the two adopted; one query when nothing is missing),
// an archived agent gets none until it is restored, people keep making theirs on first open; an empty one posts no
// line, counts nothing unread and wakes nobody; the first run's Manager chat stays the one chat onboarding.start uses.
// Owns: these assertions. Never: the UI's order of such chats (test/unit/ui/chat-list-order.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { harness, tick } from './harness.ts';
import { ensureOwnerDirects, findDirect, findOrCreateDirect, isDirect, keepOwnerDirects } from '../../../src/runtime/chat/direct.ts';
import { Org } from '../../../src/runtime/org/service.ts';
import { Onboarding } from '../../../src/runtime/onboarding/service.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';

const RESOURCES = path.resolve(import.meta.dirname, '../../../resources');
const ANNA = 'per_anna000000';

/** The chat harness (real chats, delivery, wakes) with the real org on the same database and bus. */
function setup() {
  const h = harness();
  const org = new Org({ db: h.db, bus: h.bus, clock: h.clock, templatesDir: path.join(RESOURCES, 'agents') });
  (h.services as { org: unknown }).org = org;
  h.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, 'Anna Berg', 'active', 0, 0)`, [ANNA]);
  return { ...h, org, services: h.services as RuntimeServices };
}

const allChats = (h: ReturnType<typeof setup>) => h.chats.list({ includeHidden: true });

/** The owner's default 1:1 with `agentId` is there, untitled and empty, and asks nothing of anyone. */
function assertQuietDefault(h: ReturnType<typeof setup>, agentId: string): string {
  const id = findDirect(h.services, HUMAN_ID, agentId);
  assert.ok(id, `a default 1:1 with ${agentId}`);
  const chat = h.chats.get(id)!;
  assert.equal(isDirect(chat), true);
  assert.equal(chat.title, '', 'untitled: the list names it after the agent');
  assert.deepEqual(h.chats.members(id).map((m) => [m.memberId, m.role]), [[HUMAN_ID, 'owner'], [agentId, 'lead']]);
  assert.equal(h.chats.messages(id).length, 0, 'no line – not even a status line');
  const summary = h.chats.summary(id);
  assert.equal(summary.unread, 0);
  assert.equal(summary.importantUnread, undefined);
  assert.equal(summary.lastPreview, undefined);
  assert.equal(summary.lastMessageAt, undefined);
  return id;
}

test('a hire gets the owner\'s default 1:1 at once – a sub-agent and an agent\'s own hire too; empty, unread nothing, wakes nobody', async () => {
  const h = setup();
  const off = keepOwnerDirects(h.services);
  const manager = h.org.ensureSeed()!;
  const mira = h.org.create({ name: 'Mira', role: 'Research', createdBy: HUMAN_ID });
  const ben = h.org.create({ name: 'Ben', managerId: mira.id, createdBy: HUMAN_ID });
  const ada = h.org.create({ name: 'Ada', createdBy: manager.id });
  await Promise.resolve(); // right after the announcement (a microtask) – before any reply to the hire goes out
  const ids = [manager, mira, ben, ada].map((agent) => assertQuietDefault(h, agent.id));
  assert.equal(new Set(ids).size, 4);
  assert.equal(allChats(h).length, 4, 'one chat per agent, nothing else');
  assert.deepEqual(h.wakeRows(), [], 'no agent is woken');
  assert.deepEqual(h.urgent, []);
  assert.deepEqual(h.notified, [], 'nothing notifies the person');
  // The agent is announced before its chat, so a window knows the name the chat is shown under.
  const order = h.events.filter((e) => e.event === 'agent.upserted' || e.event === 'conversation.upserted')
    .map((e) => (e.event === 'agent.upserted' ? `agent:${(e.data as { id: string }).id}` : `chat:${(e.data as { id: string }).id}`));
  assert.ok(order.indexOf(`agent:${mira.id}`) < order.indexOf(`chat:${ids[1]}`), order.join(' '));

  // Every later announcement of the same agent (status, an edit) makes nothing.
  h.org.setStatus(mira.id, 'working', 'reading');
  h.org.update(ben.id, { role: 'Video' });
  await tick();
  assert.equal(allChats(h).length, 4);
  // A hire inside a transaction that is rolled back (a failed team proposal) leaves no chat behind.
  assert.throws(() => h.db.tx(() => { h.org.create({ name: 'Ghost', createdBy: HUMAN_ID }); throw new Error('proposal failed'); }), /proposal failed/);
  await tick();
  assert.equal(allChats(h).length, 4, 'no chat for an agent that was never hired');
  h.org.create({ name: 'Lea', createdBy: HUMAN_ID });
  off();
  await tick();
  assert.equal(allChats(h).length, 4, 'unsubscribed: a hire waits for the next start (or its first use)');
});

test('start-up backfill: one per active agent in one go, an older chat of the two adopted, none for an archived agent or a person; idempotent', async () => {
  const h = setup();
  const manager = h.org.ensureSeed()!;
  const mira = h.org.create({ name: 'Mira', createdBy: HUMAN_ID });
  const tom = h.org.create({ name: 'Tom', createdBy: HUMAN_ID });
  const old = h.org.create({ name: 'Old', createdBy: HUMAN_ID });
  h.org.archive(old.id);
  const before = findOrCreateDirect(h.services, HUMAN_ID, manager.id); // the first run's chat (as before Runde 4)
  const topic = h.chats.create({ title: 'Video editing', agentIds: [mira.id], createdBy: HUMAN_ID });
  h.clock.advance(1000);
  const older = h.chats.create({ agentIds: [tom.id], createdBy: HUMAN_ID });
  h.chats.send({ conversationId: older.id, body: 'Can you check the invoice?', authorId: HUMAN_ID, authorKind: 'human' });
  const wakesBefore = h.wakeRows().length;

  const made = ensureOwnerDirects(h.services);
  assert.deepEqual(made.sort(), [mira.id, tom.id].sort(), 'only the agents without one');
  assert.equal(findDirect(h.services, HUMAN_ID, manager.id), before, 'the Manager keeps its chat');
  assert.equal(findDirect(h.services, HUMAN_ID, tom.id), older.id, 'an older untitled chat of the two is adopted, not doubled');
  assertQuietDefault(h, mira.id);
  assert.notEqual(findDirect(h.services, HUMAN_ID, mira.id), topic.id, 'a chat named after a topic stays a topic chat');
  assert.equal(findDirect(h.services, HUMAN_ID, old.id), undefined, 'an archived agent gets no new chat');
  assert.equal(findDirect(h.services, ANNA, mira.id), undefined, 'people keep making theirs on first open');
  assert.equal(findDirect(h.services, HUMAN_ID, ANNA), undefined);
  assert.equal(allChats(h).length, 4, 'Manager, topic, Tom (adopted) and the one new chat with Mira');
  assert.equal(h.wakeRows().length, wakesBefore, 'the backfill wakes nobody');

  // A second start finds every one with a single query over the owner's chats.
  const statements: string[] = [];
  const db = h.db as unknown as Record<'all' | 'get' | 'run', (sql: string, params?: unknown[]) => unknown>;
  const real = { all: db.all.bind(h.db), get: db.get.bind(h.db), run: db.run.bind(h.db) };
  for (const name of ['all', 'get', 'run'] as const) db[name] = (sql, params) => { statements.push(sql); return real[name](sql, params); };
  const off = keepOwnerDirects(h.services);
  for (const name of ['all', 'get', 'run'] as const) db[name] = real[name];
  assert.equal(statements.filter((sql) => /conversations/.test(sql)).length, 1, statements.join('\n---\n'));
  assert.equal(allChats(h).length, 4, 'idempotent');
  assert.deepEqual(ensureOwnerDirects(h.services), []);

  // An archived agent's announcement makes nothing; brought back, it is an active agent again and gets its chat.
  h.bus.emit('agent.upserted', h.org.get(old.id)!);
  await tick();
  assert.equal(findDirect(h.services, HUMAN_ID, old.id), undefined);
  h.org.restore(old.id);
  await tick();
  assertQuietDefault(h, old.id);
  assert.equal(allChats(h).length, 5);
  off();
});

test('the backfill is one transaction: a failure leaves no half-made chats, and the start goes on', () => {
  const h = setup();
  h.org.create({ name: 'Mira', createdBy: HUMAN_ID });
  h.org.create({ name: 'Tom', createdBy: HUMAN_ID });
  const warnings: string[] = [];
  const chats = h.services.chats;
  let made = 0;
  const failing = { ...h.services, log: { ...h.services.log, warn: (message: string) => warnings.push(message) },
    chats: Object.assign(Object.create(chats) as typeof chats, { create: (input: Parameters<typeof chats.create>[0]) => {
      if (++made === 2) throw new Error('disk full');
      return chats.create(input);
    } }) } as RuntimeServices;
  const off = keepOwnerDirects(failing);
  assert.deepEqual(warnings, ['default chats with the agents not backfilled']);
  assert.equal(allChats(h).length, 0, 'the first chat went back with the second');
  off();
  keepOwnerDirects(h.services)();
  assert.equal(allChats(h).length, 2, 'the next start makes both');
});

test('first run: the seeded Manager\'s default 1:1 is the first chat – onboarding.start uses it, no second chat', () => {
  const h = setup();
  const settings = new SettingsStore({ db: h.db, bus: h.bus, clock: h.clock, env: { locale: 'en-US', timezone: 'UTC' } });
  Object.assign(h.services, {
    settings, accounts: { list: () => [], detect: async () => ({}) },
    prompts: new PromptTemplates(() => path.join(RESOURCES, 'prompts')),
  });
  const manager = h.org.ensureSeed()!; // main.ts: ensureSeed, then keepOwnerDirects
  const off = keepOwnerDirects(h.services);
  const first = assertQuietDefault(h, manager.id);
  const { conversationId } = new Onboarding({ services: () => h.services }).start();
  assert.equal(conversationId, first);
  assert.equal(findOrCreateDirect(h.services, HUMAN_ID, manager.id), first);
  assert.equal(allChats(h).length, 1, 'no duplicate first-run chat');
  off();
});
