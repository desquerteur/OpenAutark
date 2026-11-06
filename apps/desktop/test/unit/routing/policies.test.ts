// Model policies: get/set round trips for the global, agent and chat+agent scopes, validation,
// the PolicyApi factory, and keyword category inference (RT8: cutting, podcasts, subtitles).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, setup } from '../models/harness.ts';
import { cleanPolicy, createPolicyApi, effectivePolicy, getPolicy, setPolicy } from '../../../src/runtime/routing/policies.ts';
import { defaultEffortFor, inferCategory, resolveCategory } from '../../../src/runtime/routing/categories.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

const isBadRequest = (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request';

test('global default policy: set, get, clear', () => {
  const h = setup();
  assert.equal(getPolicy(h.services, {}), null);
  setPolicy(h.services, {}, { costMode: 'economy', ceilingTier: 'strong', effort: 'low' });
  // 23.10.2026: one global cost mode – the default policy's goes to Settings.routing.costMode.
  assert.deepEqual(getPolicy(h.services, {}), { ceilingTier: 'strong', effort: 'low' });
  assert.equal(h.settings.get().routing.costMode, 'economy');
  setPolicy(h.services, {}, {});
  assert.equal(getPolicy(h.services, {}), null);
  // 01.11.2026: one default model – a global pin is the Work use (settings.json routing.work).
  setPolicy(h.services, {}, { pin: 'claude:claude-opus-5-5' });
  assert.equal(h.settings.get().routing.work, 'claude:claude-opus-5-5');
  assert.deepEqual(getPolicy(h.services, {}), { pin: 'claude:claude-opus-5-5' });
});

test('an older stored global pin moves to the Work use once (while Work is auto)', () => {
  const h = setup();
  h.settings.update({ routing: { work: 'auto' } });
  h.db.run('INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, ?, ?)', ['routing', 'default_policy', JSON.stringify({ pin: 'codex:gpt-6.1-sol', effort: 'low' }), 1]);
  assert.deepEqual(getPolicy(h.services, {}), { effort: 'low', pin: 'codex:gpt-6.1-sol' });
  assert.equal(h.settings.get().routing.work, 'codex:gpt-6.1-sol');
  const left = h.db.get<{ value: string }>('SELECT value FROM kv WHERE ns = ? AND key = ?', ['routing', 'default_policy']);
  assert.deepEqual(JSON.parse(String(left?.value)), { effort: 'low' });
});

test('agent policy goes through org.update and comes back normalized', () => {
  const h = setup();
  h.agents.set('ag_1', agent('ag_1'));
  assert.equal(getPolicy(h.services, { agentId: 'ag_1' }), null);
  setPolicy(h.services, { agentId: 'ag_1' }, { pin: 'claude:claude-opus-5-5', effort: 'X-High' as never, floorTier: 'strong', prefer: ['a', 'a', 'b'] });
  assert.deepEqual(getPolicy(h.services, { agentId: 'ag_1' }), { pin: 'claude:claude-opus-5-5', effort: 'xhigh', floorTier: 'strong', prefer: ['a', 'b'] });
  assert.deepEqual(h.agents.get('ag_1')!.modelPolicy.pin, 'claude:claude-opus-5-5');
  setPolicy(h.services, { agentId: 'ag_1' }, { pin: 'auto' });
  assert.equal(getPolicy(h.services, { agentId: 'ag_1' }), null);
  assert.throws(() => setPolicy(h.services, { agentId: 'ag_missing' }, {}), (error: unknown) => error instanceof WorkforceError && error.code === 'not_found');
});

test('validation rejects impossible bands and unknown values', () => {
  assert.throws(() => cleanPolicy({ floorTier: 'frontier', ceilingTier: 'small' }), isBadRequest);
  assert.throws(() => cleanPolicy({ costMode: 'cheap' }), isBadRequest);
  assert.throws(() => cleanPolicy({ effort: 'turbo' }), isBadRequest);
  assert.throws(() => cleanPolicy({ floorTier: 'huge' }), isBadRequest);
  assert.throws(() => cleanPolicy({ avoid: 'x' }), isBadRequest);
  assert.throws(() => cleanPolicy([]), isBadRequest);
  assert.deepEqual(cleanPolicy({ pin: '', effort: 'auto', unknown: 1 }), {});
});

test('chat + agent scope stores only the composer choice and keeps other agents', () => {
  const h = setup();
  h.agents.set('ag_1', agent('ag_1'));
  h.agents.set('ag_2', agent('ag_2'));
  h.addChat('ch_1', ['ag_1', 'ag_2'], { models: { ag_2: 'codex:gpt-6.1-sol' }, efforts: { ag_2: 'high' }, mode: 'video' });
  setPolicy(h.services, { agentId: 'ag_1', conversationId: 'ch_1' }, { pin: 'claude:claude-opus-5-5', effort: 'max', ceilingTier: 'small' });
  const settings = h.conversations.get('ch_1')!.settings;
  assert.deepEqual(settings.models, { ag_2: 'codex:gpt-6.1-sol', ag_1: 'claude:claude-opus-5-5' });
  assert.deepEqual(settings.efforts, { ag_2: 'high', ag_1: 'max' });
  assert.equal(settings.mode, 'video');
  assert.deepEqual(getPolicy(h.services, { agentId: 'ag_1', conversationId: 'ch_1' }), { pin: 'claude:claude-opus-5-5', effort: 'max' });

  setPolicy(h.services, { agentId: 'ag_1', conversationId: 'ch_1' }, { pin: 'auto' });
  assert.deepEqual(h.conversations.get('ch_1')!.settings.models, { ag_2: 'codex:gpt-6.1-sol' });
  assert.deepEqual(h.conversations.get('ch_1')!.settings.efforts, { ag_2: 'high' });
  assert.equal(getPolicy(h.services, { agentId: 'ag_1', conversationId: 'ch_1' }), null);

  // A group needs the agent named; a 1:1 chat resolves its only agent.
  assert.throws(() => getPolicy(h.services, { conversationId: 'ch_1' }), isBadRequest);
  h.addChat('ch_2', ['ag_1']);
  const api = createPolicyApi(() => h.services);
  api.set({ conversationId: 'ch_2' }, { effort: 'low' });
  assert.deepEqual(api.get({ conversationId: 'ch_2' }), { effort: 'low' });
  assert.deepEqual(api.get({ agentId: 'ag_1', conversationId: 'ch_2' }), { effort: 'low' });
});

test('effective policy: chat pin > agent pin (the default model is the Work use); agent bounds override defaults', () => {
  const h = setup();
  setPolicy(h.services, {}, { pin: 'x:default', floorTier: 'strong', costMode: 'best', avoid: ['x:bad'], effort: 'low' });
  const a = agent('ag_1', { modelPolicy: { ceilingTier: 'small', effort: 'high', avoid: ['x:worse'] } });
  h.addChat('ch_1', ['ag_1'], { models: { ag_1: 'x:chat' }, efforts: { ag_1: 'medium' } });
  const inChat = effectivePolicy(h.services, a, 'ch_1');
  assert.deepEqual(inChat.pin, { modelId: 'x:chat', source: 'chat' });
  assert.equal(inChat.agentEffort, 'high');
  assert.equal(inChat.chatEffort, 'medium');
  assert.equal(inChat.defaultEffort, 'low');
  assert.equal(inChat.ceilingTier, 'small');
  assert.equal(inChat.floorTier, undefined, 'the default floor would contradict the agent ceiling');
  assert.equal(inChat.costMode, undefined, 'the default cost mode lives in Settings.routing (the router falls back to it)');
  assert.equal(h.settings.get().routing.costMode, 'best');
  assert.deepEqual(inChat.avoid.sort(), ['x:bad', 'x:worse']);
  assert.equal(effectivePolicy(h.services, agent('ag_2'), undefined).pin, undefined);
  assert.equal(h.settings.get().routing.work, 'x:default');
});

test('categories: the mode wins, the general chat category is refined by keywords', () => {
  assert.equal(inferCategory('Kannst du die Buchhaltung für die Rechnungen von März machen?'), 'business-workflows');
  assert.equal(inferCategory('Bitte recherchiere Studien zu Schlaf und Konzentration'), 'research');
  assert.equal(inferCategory('Fix the TypeScript stack trace in the repository'), 'coding');
  assert.equal(inferCategory('Erinnere mich morgen an den Termin beim Arzt'), 'personal-assistant');
  assert.equal(inferCategory('Write a caption for Instagram and a few hashtags'), 'social-media');
  // RT8: cutting, podcasts, thumbnails and subtitles are video work.
  assert.equal(inferCategory('Schneide den Podcast'), 'video-animation');
  assert.equal(inferCategory('Kannst du die Folge zusammenschneiden und ein Thumbnail machen?'), 'video-animation');
  assert.equal(inferCategory('Erstelle deutsche Untertitel'), 'video-animation');
  assert.equal(inferCategory('Add English subtitles, please'), 'video-animation');
  assert.equal(inferCategory('Schneid das Intro raus'), 'video-animation');
  assert.equal(inferCategory('Wir müssen uns heute entscheiden'), undefined); // "schneid" is not in "entscheiden"
  // A generic word counts once, and the surname is no cutting: these are no video work.
  assert.equal(inferCategory('Schreib eine Mail an Herrn Schneider, dass Herr Schneider morgen kommt'), undefined);
  assert.equal(inferCategory('Schreib Herrn Schneider eine Mail über den neuen Podcast'), undefined);
  assert.equal(inferCategory('Ich muss die Hecke schneiden und die Rosen zuschneiden'), undefined);
  assert.equal(inferCategory('Kannst du mir morgen die Haare schneiden? Nur kurz schneiden'), undefined);
  assert.equal(inferCategory('Welchen Podcast kannst du empfehlen? Am liebsten einen Podcast über Geschichte'), undefined);
  assert.equal(inferCategory('Plan the plan, plan it well'), undefined); // one generic word three times
  assert.equal(inferCategory('Please determine the best option'), undefined); // "termin" only at a word start
  assert.equal(inferCategory('Hey team, how are you?'), undefined); // one weak word is not enough
  assert.equal(inferCategory(''), undefined);
  assert.equal(resolveCategory('video-animation', 'summarize this'), 'video-animation');
  assert.equal(resolveCategory('chat', 'summarize this thread for me'), 'cheap-chat');
  assert.equal(resolveCategory('chat', 'hello'), 'chat');
  assert.equal(resolveCategory('custom-thing', undefined), 'chat');
  // B-047 D12: the manager mode's category is refined by the turn's text like 'chat'; without text it stays.
  assert.equal(resolveCategory('manager-planner', 'Recherchiere die Firma und vergleiche die Quellen'), 'research');
  assert.equal(resolveCategory('manager-planner', 'Hi, how are you?'), 'chat');
  assert.equal(resolveCategory('manager-planner', 'Plan the roadmap and delegate the milestones'), 'manager-planner');
  assert.equal(resolveCategory('manager-planner', undefined), 'manager-planner');
  assert.equal(defaultEffortFor('manager-planner'), 'high');
  assert.equal(defaultEffortFor('cheap-chat'), 'low');
  assert.equal(defaultEffortFor('research'), 'medium');
});
