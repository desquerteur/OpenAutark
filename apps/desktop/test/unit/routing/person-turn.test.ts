// A person's own request (routing/person-turn.ts): a turn with a new line of a person runs on the strongest model the
// Work use allows at effort ≥ high; turns without one, helper calls, pins, a fixed effort and the cheaper cost mode
// keep the usual route.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { account, agent, mode, setup, standardSetup } from '../models/harness.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import { SYSTEM_ID } from '../../../src/shared/ids.ts';
import { personAsks, personEffort, personValue, strongestPick, topTier } from '../../../src/runtime/routing/person-turn.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import type { Effort } from '../../../src/shared/model/providers.ts';
import type { RouteRequest } from '../../../src/runtime/contracts.ts';

const chat = mode('chat');

/** standardSetup plus a chat whose lines the fake chat service returns after a read cursor. */
async function withChat(lines: Array<{ seq: number; authorKind: Message['authorKind']; kind?: Message['kind'] }>, readSeq = 0) {
  const h = await standardSetup();
  h.addChat('ch_1', ['ag_1']);
  const members = (h.services.chats as unknown as { members(id: string): Array<{ memberId: string; readSeq: number }> }).members('ch_1');
  for (const member of members) if (member.memberId === 'ag_1') member.readSeq = readSeq;
  Object.assign(h.services.chats, {
    messages: (_id: string, options: { afterSeq?: number } = {}) => lines
      .filter((line) => line.seq > (options.afterSeq ?? 0))
      .map((line) => ({ seq: line.seq, authorKind: line.authorKind, kind: line.kind ?? 'text', authorId: line.authorKind === 'human' ? 'human' : 'ag_2', body: 'x' })),
  });
  return h;
}

function request(patch: Partial<RouteRequest> = {}): RouteRequest {
  return { agent: agent('ag_1'), mode: chat, conversationId: 'ch_1', ...patch };
}

test("a person's new line: the strongest model at effort high; without one the usual route", async () => {
  const h = await withChat([{ seq: 1, authorKind: 'human' }]);
  const asked = await h.router.route(request());
  assert.equal(h.catalog.get(asked.modelId)!.tier, 'frontier');
  assert.equal(asked.effort, 'high');
  assert.match(asked.reason, /a person's request · strongest model/);

  const read = await withChat([{ seq: 1, authorKind: 'human' }, { seq: 2, authorKind: 'agent' }], 1);
  const background = await read.router.route(request());
  assert.equal(background.effort, 'medium', 'nothing new from a person: the usual chat effort');
  assert.doesNotMatch(background.reason, /person/);

  const status = await withChat([{ seq: 1, authorKind: 'human', kind: 'status' }, { seq: 2, authorKind: 'human', kind: 'task' }]);
  assert.doesNotMatch((await status.router.route(request())).reason, /person/, 'a status line or a task card is no request');
  const answer = await withChat([{ seq: 1, authorKind: 'human', kind: 'answer' }]);
  assert.match((await answer.router.route(request())).reason, /a person's request/, 'an answer to the agent is');
});

test('helper calls, splits and turns without a chat keep the usual route', async () => {
  const h = await withChat([{ seq: 1, authorKind: 'human' }]);
  assert.equal(personAsks(h.services, { agent: agent(SYSTEM_ID), conversationId: 'ch_1' }), false);
  assert.equal(personAsks(h.services, { agent: agent('ag_1'), conversationId: 'ch_1', split: { splitId: 'sp_1' } }), false);
  assert.equal(personAsks(h.services, { agent: agent('ag_1') }), false);
  assert.equal(personAsks(h.services, { agent: agent('ag_9'), conversationId: 'ch_1' }), false, 'not a member of the chat');
  assert.equal(personAsks(h.services, { agent: agent('ag_1'), conversationId: 'ch_1' }), true);
});

test('a Work model set in Settings, a fixed effort and the cheaper cost mode win over the rule', async () => {
  const pinned = await withChat([{ seq: 1, authorKind: 'human' }]);
  pinned.settings.update({ routing: { work: 'claude:claude-haiku-5-5' } });
  const byUse = await pinned.router.route(request());
  assert.equal(byUse.modelId, 'claude:claude-haiku-5-5');
  assert.equal(byUse.by, 'pin');

  const fixed = await withChat([{ seq: 1, authorKind: 'human' }]);
  fixed.addChat('ch_2', ['ag_1'], { efforts: { ag_1: 'low' } });
  Object.assign(fixed.services.chats, { messages: () => [{ seq: 1, authorKind: 'human', kind: 'text' }] });
  const low = await fixed.router.route(request({ conversationId: 'ch_2' }));
  assert.equal(low.effort, 'low', 'the chat effort the person chose stays');
  assert.equal(fixed.catalog.get(low.modelId)!.tier, 'frontier');

  const economy = await withChat([{ seq: 1, authorKind: 'human' }]);
  economy.settings.update({ routing: { costMode: 'economy' } });
  const cheap = await economy.router.route(request());
  assert.equal(economy.catalog.get(cheap.modelId)!.tier, 'small');
});

test('the previous model of the top tier goes on (its session), with at least high effort', async () => {
  const h = await withChat([{ seq: 1, authorKind: 'human' }]);
  const kept = await h.router.route(request({ previous: { modelId: 'claude:claude-opus-5-5', effort: 'medium', category: 'chat' } }));
  assert.equal(kept.modelId, 'claude:claude-opus-5-5');
  assert.equal(kept.effort, 'high');
  const higher = await h.router.route(request({ previous: { modelId: 'claude:claude-opus-5-5', effort: 'max', category: 'chat' } }));
  assert.equal(higher.effort, 'max', 'a higher effort is never lowered');
  const small = await h.router.route(request({ previous: { modelId: 'claude:claude-haiku-5-5', effort: 'low', category: 'chat' } }));
  assert.equal(h.catalog.get(small.modelId)!.tier, 'frontier', 'a smaller previous model gives way');
});

test('helpers: top tier and effort floor', () => {
  const pool = [{ model: { tier: 'small' } }, { model: { tier: 'frontier' } }, { model: { tier: 'strong' } }, { model: { tier: 'frontier' } }] as Array<{ model: { tier: 'small' | 'strong' | 'frontier' } }>;
  assert.equal(topTier(pool as never[]).length, 2);
  assert.equal(personEffort('low'), 'high');
  assert.equal(personEffort('xhigh'), 'xhigh');
});

test('strongestPick: a previous model weak for the work is left and named (the switch line\'s why); a fitting one goes on', () => {
  const sol = { model: { id: 'sol', strengths: { 'video-animation': -0.5 } } };
  const opus = { model: { id: 'opus', strengths: { 'video-animation': 0.6 } } };
  assert.deepEqual(strongestPick([opus, sol] as never[], 'video-animation', 'sol'), { entry: opus, kept: false, left: sol, why: 'weak' });
  assert.deepEqual(strongestPick([opus, sol] as never[], 'coding', 'sol'), { entry: sol, kept: true });
  assert.deepEqual(strongestPick([sol] as never[], 'video-animation', 'sol'), { entry: sol, kept: false }, 'nothing better: nothing left');
});

// B-078 (D16, live 06.11.2026: Fable and Astra ran at about 2.5x the cost of Opus): with the shipped priors an ordinary line
// of the owner – a chat or a text to write – runs on Opus 5.5, and a chat that ran on Fable moves to Opus.
const SHIPPED = Priors.load(path.resolve(import.meta.dirname, '../../../resources/model-priors.json'));

async function claudePlan(work?: string) {
  const h = setup({ priors: SHIPPED });
  if (work) h.settings.update({ routing: { work } });
  h.accounts.upsert(account('acc_claude', 'claude'), false);
  h.accounts.upsert(account('acc_codex', 'codex'), false);
  h.engine('claude').lists.set('claude', ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map((model) => ({ model, name: model, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as Effort[] })));
  h.engine('codex').lists.set('codex', ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'].map((model) => ({ model, name: model, efforts: ['low', 'medium', 'high', 'xhigh'] as Effort[] })));
  await h.catalog.refresh({ force: true });
  h.addChat('ch_1', ['ag_1']);
  Object.assign(h.services.chats, { messages: () => [{ seq: 1, authorKind: 'human', kind: 'text', authorId: 'human', body: 'x' }] });
  return h;
}

test('the owner\'s ordinary chat or writing line runs on Opus 5.5, not on Fable 5.1 or GPT-6 Astra (the work plan is Claude)', async () => {
  const h = await claudePlan('auto');
  const chatLine = await h.router.route(request());
  assert.equal(chatLine.modelId, 'claude:claude-opus-5-5', chatLine.reason);
  assert.match(chatLine.reason, /a person's request · strongest model/);
  const writing = await h.router.route(request({ text: 'Schreib mir bitte einen LinkedIn-Post über unser neues Produkt, locker und menschlich.' }));
  assert.equal(writing.category === 'writing' || writing.category === 'social-media', true, writing.category);
  assert.equal(writing.modelId, 'claude:claude-opus-5-5', writing.reason);
  const essay = await h.router.route(request({ mode: mode('writing') }));
  assert.equal(essay.modelId, 'claude:claude-opus-5-5', essay.reason);
});

test('a chat that ran on Fable 5.1 moves to Opus 5.5 for the owner\'s next line, and the reason says why', async () => {
  const h = await claudePlan('claude');
  const moved = await h.router.route(request({ mode: mode('writing'), previous: { modelId: 'claude:claude-fable-5-1', effort: 'high', category: 'writing' } }));
  assert.equal(moved.modelId, 'claude:claude-opus-5-5');
  assert.match(moved.reason, /Claude Opus 5\.5 does this as well for less than Claude Fable 5\.1/);
});

test('strongestPick: a switch to a pricier, clearly stronger model says "stronger", never "for less"', () => {
  const sol = { model: { id: 'sol', tier: 'frontier', smarts: 93, relCost: 0.3, strengths: { 'frontend-ui': 0.1 } }, score: 0.1 } as never;
  const opus = { model: { id: 'opus', tier: 'frontier', smarts: 94, relCost: 0.4, strengths: { 'frontend-ui': 0.8 } }, score: 0.8 } as never;
  assert.deepEqual(strongestPick([opus, sol], 'frontend-ui', 'sol'), { entry: opus, kept: false, left: sol, why: 'stronger' });
});

test('a chat on GPT-6.1 Sol moves to Opus 5.5 for the owner\'s frontend line, and the reason says Opus is stronger', async () => {
  const h = await claudePlan('auto');
  const moved = await h.router.route(request({ text: 'Bau mir bitte eine Landingpage mit Tailwind, frontend und user interface.', previous: { modelId: 'codex:gpt-6.1-sol', effort: 'high', category: 'frontend-ui' } }));
  assert.equal(moved.category, 'frontend-ui', moved.reason);
  assert.equal(moved.modelId, 'claude:claude-opus-5-5', moved.reason);
  assert.match(moved.reason, /Claude Opus 5\.5 is stronger at .+ than GPT-6\.1 Sol/);
  assert.doesNotMatch(moved.reason, /for less than/);
});

test('personValue: 2 points smarter at 2.5x the price loses, 20 points smarter at 1.5x wins', () => {
  const opus = { model: { id: 'opus', tier: 'frontier', smarts: 94, relCost: 0.4, strengths: {} } } as never;
  const pricey = { model: { id: 'pricey', tier: 'frontier', smarts: 96, relCost: 1, strengths: {} } } as never;
  const smart = { model: { id: 'smart', tier: 'frontier', smarts: 114, relCost: 0.6, strengths: {} } } as never;
  assert.ok(personValue(opus) > personValue(pricey));
  assert.ok(personValue(smart) > personValue(opus));
  assert.equal(strongestPick([pricey, opus], 'chat')!.entry, opus);
});
