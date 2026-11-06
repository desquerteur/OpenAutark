// The first-run window side (src/ui/onboarding): which agent is the Manager and which chat is its first
// chat (the chat the first run opens); first-run.ts – the layer shows only for the owner while its step is
// not 'done' and a card change writes the step together with the card's own choice; the removed setup-chip
// and setup-notice files stay removed. About you asks only the name and the company (kept in the card's draft over
// a remount), there is no permission question, and Start calls onboarding.start without params. The AI card's
// Continue waits until a model can answer: there is no Skip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { SessionInfo } from '../../../src/shared/api/methods.ts';
import type { ConversationSummary } from '../../../src/shared/model/chat.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { Settings } from '../../../src/shared/model/system.ts';
import { managerAgent, managerFirstChat } from '../../../src/ui/onboarding/manager.ts';
import { rpc } from '../../../src/ui/lib/rpc.ts';
import { session } from '../../../src/ui/lib/session.ts';
import { settings } from '../../../src/ui/lib/store.ts';
import { route } from '../../../src/ui/lib/router.ts';

// first-run.ts calls through rpc: answered here, never sent anywhere.
const calls: Array<{ method: string; params: unknown }> = [];
(rpc as unknown as { onOpen: unknown }).onOpen = () => () => undefined;
(rpc as unknown as { call: unknown }).call = async (method: string, params: unknown) => {
  calls.push({ method, params });
  return method === 'settings.update' ? settings.value : method === 'onboarding.start' ? { conversationId: 'cv_first' } : method === 'chats.get' ? null : { ok: true };
};
const { finishFirstRun, firstRunActive, goStep } = await import('../../../src/ui/onboarding/first-run.ts');
const root = path.resolve(import.meta.dirname, '..', '..', '..');

function agent(id: string, extra: Partial<Agent> = {}): Agent {
  return { id, name: id, mode: 'general', createdAt: 1, ...extra } as unknown as Agent;
}

function chat(id: string, createdAt: number, agentIds: Array<string | { id: string; left: true }>, extra: Partial<ConversationSummary> = {}): ConversationSummary {
  const members = [
    { memberId: 'human', kind: 'human' },
    ...agentIds.map((entry) => (typeof entry === 'string'
      ? { memberId: entry, kind: 'agent' }
      : { memberId: entry.id, kind: 'agent', leftAt: 5 })),
  ];
  return { id, title: id, createdAt, settings: {}, members, ...extra } as unknown as ConversationSummary;
}

test('managerAgent: the personal manager (manager template first, then top-level, oldest first), never archived', () => {
  const list = [
    agent('worker', { createdAt: 1 }),
    agent('sub-manager', { template: 'manager', managerId: 'boss', createdAt: 2 }),
    agent('archived', { template: 'manager', archivedAt: 3, createdAt: 0 }),
    agent('boss', { mode: 'manager', createdAt: 5 }),
    agent('boss-2', { template: 'manager', createdAt: 9 }),
  ];
  // B-078 (D15): the seed is the Personal manager (template 'manager'); a department head in mode manager beside it is not it.
  assert.equal(managerAgent(list)?.id, 'boss-2');
  assert.equal(managerAgent(list.filter((a) => a.id !== 'boss-2'))?.id, 'sub-manager', 'the template counts before the top level');
  assert.equal(managerAgent([agent('worker'), agent('head', { mode: 'manager', createdAt: 5 }), agent('head-2', { mode: 'manager', createdAt: 2, managerId: 'head' })])?.id, 'head', 'no template: the top-level mode manager');
  assert.equal(managerAgent([agent('worker')]), undefined);
});

test('managerFirstChat: oldest visible chat whose only current agent is the manager', () => {
  const chats = [
    chat('group', 1, ['boss', 'worker']),
    chat('hidden', 2, ['boss'], { settings: { hiddenFromList: true } } as Partial<ConversationSummary>),
    chat('archived', 3, ['boss'], { archivedAt: 4 } as Partial<ConversationSummary>),
    chat('second', 20, ['boss']),
    chat('first', 10, ['boss', { id: 'worker', left: true }]), // a former member does not count
    chat('other', 0, ['worker']),
  ];
  assert.equal(managerFirstChat(chats, 'boss')?.id, 'first');
  assert.equal(managerFirstChat(chats, 'nobody'), undefined);
});

test('the layer is active for the owner while the step is not done; a card writes its step with its choice', async () => {
  settings.value = { onboarding: { completed: false, step: 'ai' }, profile: { name: '', company: '' } } as unknown as Settings;
  session.value = { kind: 'owner', allowedMethods: [], capabilities: [] } as unknown as SessionInfo;
  assert.equal(firstRunActive(), true);
  session.value = { kind: 'device', allowedMethods: ['messages.send'], capabilities: ['chat'] } as unknown as SessionInfo;
  assert.equal(firstRunActive(), false, 'a phone shows Home');
  session.value = { kind: 'owner', allowedMethods: [], capabilities: [] } as unknown as SessionInfo;

  await goStep('about', { profile: { name: 'Ada' } });
  assert.deepEqual(calls.at(-1), { method: 'settings.update', params: { profile: { name: 'Ada' }, onboarding: { step: 'about' } } });
  settings.value = { ...settings.value!, onboarding: { completed: false, step: 'done' } };
  assert.equal(firstRunActive(), false, 'done: Home again');
});

test('the setup-chip path and the setup notice are gone', () => {
  for (const file of ['SetupSuggestion.tsx', 'StartPaths.tsx', 'suggestion.ts', 'setup-rules.ts', 'SetupLine.tsx', 'setup-notice.ts']) assert.equal(existsSync(path.join(root, 'src/ui/onboarding', file)), false, file);
});

test('Start calls onboarding.start without params and opens the Manager\'s chat', async () => {
  // The router writes the hash in a window: a small stand-in (as task-jump.test.ts).
  const hashes = ['#/home'];
  Object.assign(globalThis, {
    location: { get hash() { return hashes[hashes.length - 1]; } },
    history: {
      pushState: (_state: unknown, _title: string, hash: string) => { hashes.push(hash); },
      replaceState: (_state: unknown, _title: string, hash: string) => { hashes[hashes.length - 1] = hash; },
    },
  });
  calls.length = 0;
  await finishFirstRun();
  assert.deepEqual(calls.filter((call) => call.method === 'onboarding.start'), [{ method: 'onboarding.start', params: undefined }]);
  assert.deepEqual(route.value, { view: 'chat', id: 'cv_first' }, "the Manager's chat opens");
});

test('About you asks only the name and the company – kept in the draft over a remount – and no permission question', () => {
  const card = readFileSync(path.join(root, 'src/ui/onboarding/AboutCard.tsx'), 'utf8');
  assert.deepEqual([...card.matchAll(/<span class="field-label">(.*?)<\/span>/g)].map((match) => match[1]), ['Your name', 'Company']);
  assert.doesNotMatch(card, /<textarea|firstTask/, 'no first-request field');
  assert.match(card, /useState\(draft\.name \?\? profile\?\.name \?\? ''\)/, 'a remount (desktop ↔ phone shell) starts from the draft');
  assert.match(card, /draft\.company = next/, 'every change is kept in the draft');
  assert.match(card, /await finishFirstRun\(\)/, 'Start ends the first run');
  assert.match(card, /delete draft\.name; delete draft\.company;/, 'gone once the first run started');
  assert.doesNotMatch(card, /permissions|PC_USE|Who uses this PC/, 'no permission question on the card: the Manager asks in the chat');
});

test('the AI card has no Skip: Continue waits until a model can answer', () => {
  const card = readFileSync(path.join(root, 'src/ui/onboarding/AiCard.tsx'), 'utf8');
  assert.match(card, /const silent = noUsableModel\(models\.value, accounts\.value\)/);
  assert.match(card, /disabled=\{silent\}/);
  assert.doesNotMatch(card, /Skip/);
});
