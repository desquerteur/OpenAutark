// The subconscious's two brains on the real router (subconscious/service.ts, decision/engine-runner.ts, live 02.11.2026: both ran the same small model at low
// effort, so a route changed nothing): the decision model is the cheap one, the LLM the strongest of what the account has, at medium effort; a Work
// model chosen in Settings is the LLM, the cheaper cost mode keeps it cheap. No new setting.
// Owns: these assertions only. Never: real engines or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RESOURCES } from '../context/fixture.ts';
import { standardSetup } from '../models/harness.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { SubconsciousImpl } from '../../../src/runtime/subconscious/service.ts';
import type { RouteDecision } from '../../../src/shared/model/providers.ts';
import type { Router, RuntimeServices } from '../../../src/runtime/contracts.ts';

type Setup = Awaited<ReturnType<typeof standardSetup>>;

/** One asked run that routes to the LLM: the models each brain was routed to. */
async function brainsOf(h: Setup): Promise<{ decision: RouteDecision; llm: RouteDecision }> {
  const routes: RouteDecision[] = [];
  const router: Router = { route: async (request) => { const route = await h.router.route(request); routes.push(route); return route; } };
  const replies = [{ tool: 'route', args: '{"to":"llm","task":"think"}' }, { tool: 'done', args: '{"answer":"Fertig."}' }];
  const engine = { run: async () => ({ text: '', structured: replies.shift(), stop: 'done' as const }) };
  const services = {
    ...h.services, router, engines: { get: () => engine }, paths: { temp: tmpdir() },
    accounts: h.services.accounts, catalog: h.services.catalog, prompts: new PromptTemplates(() => path.join(RESOURCES, 'prompts')),
    secrets: { redact: (text: string) => text }, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as RuntimeServices;
  const agent = { id: 'ag_x', name: 'X', role: '', mode: 'general', instructions: '', skills: [], avatar: { kind: 'initials', value: 'X' }, status: 'idle', createdBy: 'human', createdAt: 0, updatedAt: 0, modelPolicy: {} };
  const answer = await new SubconsciousImpl({ services: () => services }).ask({ agent: agent as never, ask: 'Denk nach.', context: 'none' });
  assert.equal(answer, 'Fertig.\n\n(This answer used no tool, only the text it was given.)', 'route and done are no tools it looked with');
  assert.equal(routes.length, 2);
  return { decision: routes[0], llm: routes[1] };
}

test('the decision model is the cheap one, the LLM the strongest the account has', async () => {
  const h = await standardSetup();
  const { decision, llm } = await brainsOf(h);
  assert.equal(decision.modelId, 'codex:gpt-6-luna');
  assert.equal(decision.effort, 'low');
  const catalog = h.services.catalog;
  assert.equal(catalog.get(llm.modelId)?.tier, 'frontier', llm.modelId);
  assert.notEqual(llm.modelId, decision.modelId);
  assert.equal(llm.effort, 'medium');
});

test('a Work model chosen in Settings is the LLM; the cheaper cost mode keeps it cheap', async () => {
  const h = await standardSetup();
  h.settings.update({ routing: { work: 'claude:claude-haiku-5-5' } });
  assert.equal((await brainsOf(h)).llm.modelId, 'claude:claude-haiku-5-5');
  h.settings.update({ routing: { work: 'auto', costMode: 'economy' } });
  const { llm } = await brainsOf(h);
  assert.notEqual(h.services.catalog.get(llm.modelId)?.tier, 'frontier', llm.modelId);
});
