// The context ledger's wiring, checked in the source (building the core needs every service): the composition root sets
// services.ledger and starts it, the run journal keeps long outputs of captured runs only and outside the media library; a turn attempt
// attaches its run; context.restore is built in and on demand, never a core tool; superseded sessions get swept.
// Owns: these assertions only. Never: builds the core.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { builtinTools } from '../../../src/runtime/tools/builtin/index.ts';
import { coreNames } from '../../../src/runtime/tools/core-sets.ts';

const source = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');

test('services.ts sets and starts the ledger; the journal keeps captured runs\' long outputs with the raw blob put; the sweep runs', () => {
  const services = source('src/runtime/compose/services.ts');
  assert.match(services, /s\.ledger = new ContextLedgerService\(\{ services \}\);[^\n]*\n\s+s\.ledger\.start\?\.\(\);/);
  assert.match(services, /const keepBlob = blobs\.put\.bind\(blobs\);[^\n]*\n\s+s\.files = withMediaHook\(blobs,/, 'bound before the media hook wraps put');
  assert.match(services, /keepOutput: async \(text, name, runId\) => \(s\.ledger\?\.holds\?\.\(runId\) \? \(await keepBlob\(/);
  assert.match(services, /new SessionSweep\(\{/);
});

test('a turn attempt attaches its run to the ledger with the routed engine, model and the input\'s last seq', () => {
  assert.match(source('src/runtime/agents/turn-attempt.ts'), /services\.ledger\.capture\(\{ runId: request\.runId, agentId: plan\.agent\.id, conversationId: plan\.conversationId, engine: turn\.engine\.id, model: turn\.route\.modelId, seenSeq: turn\.lastSeq, first: journal \}\)/);
});

test('context.restore is built in and on demand: found through tools.find, in no core set', () => {
  const tool = builtinTools().find((entry) => entry.name === 'context.restore');
  assert.ok(tool);
  assert.equal(tool.anyMode, true);
  for (const key of ['general', 'manager']) assert.equal(coreNames({ key, tools: [] }).has('context.restore'), false, key);
});
