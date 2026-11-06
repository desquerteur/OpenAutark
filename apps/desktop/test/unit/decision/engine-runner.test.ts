// Structured runner routing (compaction, LLM decisions, verify) over the real router: the
// cheap/strong band first, the cheapest usable model of any tier when nothing in it is usable.
// Helper turns work in <temp>/helper (made again when it is gone), never at the temp root.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { account, setup } from '../models/harness.ts';
import { tempDir } from '../store/helpers.ts';
import { HELPER_DIR, createEngineRunner } from '../../../src/runtime/decision/engine-runner.ts';
import type { EngineRegistry } from '../../../src/runtime/contracts.ts';
import type { EngineModel, EngineTurnInput } from '../../../src/runtime/engines/types.ts';

const OPUS: EngineModel = { model: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'] };
const HAIKU: EngineModel = { model: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', efforts: ['low', 'medium', 'high'] };
const SOL: EngineModel = { model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high'] };
const ASTRA: EngineModel = { model: 'gpt-6-astra', name: 'GPT-6 Astra', efforts: ['low', 'medium', 'high'] };
const TEMP = tempDir('wf-helper-');
after(() => TEMP.cleanup());

async function runnerWith(lists: { claude?: EngineModel[]; codex?: EngineModel[] }) {
  const h = setup();
  for (const provider of ['claude', 'codex'] as const) {
    const models = lists[provider];
    if (!models) continue;
    h.accounts.upsert(account(`acc_${provider}`, provider), false);
    h.engine(provider).lists.set(provider, models);
  }
  await h.catalog.refresh({ force: true });
  const runs: EngineTurnInput[] = [];
  const engines = {
    get: () => ({ run: async (input: EngineTurnInput) => { runs.push(input); return { text: '{"ok":true}', stop: 'done', structured: { ok: true } }; } }),
  } as unknown as EngineRegistry;
  const runner = createEngineRunner({ engines, router: h.router, accounts: h.accounts, catalog: h.catalog, paths: { temp: TEMP.dir }, clock: h.clock });
  return { h, runner, runs };
}

test('only frontier models connected: helper calls run on one of them instead of failing', async () => {
  const { runner, runs } = await runnerWith({ claude: [OPUS] });
  const out = await runner({ purpose: 'compact', system: 'Summarize.', prompt: 'Old lines …' });
  assert.equal(out.by, 'claude:claude-opus-5-5');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].model, 'claude-opus-5-5');

  const structured = await runner({ purpose: 'decision', system: 'Decide.', prompt: 'Which?', schema: { type: 'object' } });
  assert.deepEqual(structured.structured, { ok: true });
});

test('outside the band the economy ranking still applies: the cheaper frontier model wins', async () => {
  const { runner } = await runnerWith({ codex: [ASTRA, SOL] });
  const out = await runner({ purpose: 'verify', system: 'Check.', prompt: 'Done?' });
  assert.equal(out.by, 'codex:gpt-6.1-sol'); // relCost 0.3 vs 1, neutral priors for cheap work
});

test('a cheap model inside the band still wins over frontier models', async () => {
  const { runner } = await runnerWith({ claude: [OPUS, HAIKU] });
  const out = await runner({ purpose: 'verify', system: 'Check.', prompt: 'Done?' });
  assert.equal(out.by, 'claude:claude-haiku-5-5');
});

test('no model at all: the router error reaches the caller', async () => {
  const { runner, runs } = await runnerWith({});
  await assert.rejects(runner({ purpose: 'compact', system: 'S', prompt: 'P' }), /No model is connected/);
  assert.equal(runs.length, 0);
});

test('helper turns work in a folder of their own below temp, made again when the scratch folder lost it', async () => {
  const { runner, runs } = await runnerWith({ claude: [HAIKU] });
  const helper = path.join(TEMP.dir, HELPER_DIR);
  rmSync(helper, { recursive: true, force: true });
  await runner({ purpose: 'compact', system: 'Summarize.', prompt: 'Old lines …' });
  assert.equal(runs[0].cwd, helper, 'never the temp root, where uploads and the CLI status probes live');
  assert.ok(statSync(helper).isDirectory(), 'made before the engine starts');
  rmSync(helper, { recursive: true, force: true });
  await runner({ purpose: 'verify', system: 'Check.', prompt: 'Done?' });
  assert.equal(runs[1].cwd, helper);
  assert.ok(existsSync(helper), 'made again');
  assert.deepEqual([runs[1].tools, runs[1].mcp], [[], undefined], 'still tool-less and without the MCP hub');
});

test('audit 23.10.: a helper call on a used-up or unreachable account goes once to another account; a model error does not', async () => {
  const h = setup();
  h.accounts.upsert(account('acc_claude', 'claude'), false);
  h.accounts.upsert(account('acc_codex', 'codex'), false);
  h.engine('claude').lists.set('claude', [HAIKU]);
  h.engine('codex').lists.set('codex', [SOL]);
  await h.catalog.refresh({ force: true });
  const runs: EngineTurnInput[] = [];
  let fail: Record<string, unknown> | undefined = { stop: 'limit', error: { code: 'rate_limited', message: 'The usage limit of this account was reached.' } };
  const engines = {
    get: () => ({ run: async (input: EngineTurnInput) => {
      runs.push(input);
      if (runs.length === 1 && fail) return { text: '', ...fail };
      return { text: 'ok', stop: 'done' };
    } }),
  } as unknown as EngineRegistry;
  const runner = createEngineRunner({ engines, router: h.router, accounts: h.accounts, catalog: h.catalog, paths: { temp: TEMP.dir }, clock: h.clock });
  const out = await runner({ purpose: 'compact', system: 'Summarize.', prompt: 'Old lines …' });
  assert.equal(runs.length, 2, 'one retry');
  assert.notEqual(runs[1].account.id, runs[0].account.id, 'on the other account');
  assert.equal(out.text, 'ok');

  runs.length = 0;
  fail = { stop: 'error', error: { code: 'internal', message: 'The model could not complete this turn.' } };
  await assert.rejects(runner({ purpose: 'compact', system: 'S', prompt: 'P' }), /could not complete/);
  assert.equal(runs.length, 1, 'a model failure is not retried elsewhere');
});
