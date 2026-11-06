// Registry offer and journal (review #1, #11, #23, PM2 follow-up):
// - the vault's secrets.list / secrets.generate come with browser.act (the tool that fills
//   secret:// handles) in every shipped mode that offers it, and nowhere browser.act is masked;
// - journaled summaries are redacted, and the settle update keeps the call's category (one call data object);
// - an external call that throws is journaled 'unknown' (verify before repeating); one that reports an
//   error is 'failed'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setup, tool } from './helpers.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { secretTools } from '../../../src/runtime/tools/builtin/secrets.ts';
import { browserTools } from '../../../src/runtime/browser/tools.ts';
import { ModeLibrary } from '../../../src/runtime/modes/service.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { agent } from '../chat/harness.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../../../src/runtime/tools/types.ts';

test('secrets.list and secrets.generate are offered wherever browser.act is', () => {
  const registry = new Registry({ services: () => ({}) as RuntimeServices });
  for (const entry of [...secretTools, ...browserTools({} as never)]) registry.register(entry);
  const modes = new ModeLibrary({ resources: path.resolve('resources'), clock: new ManualClock() });
  const tom = agent('ag_tom', 'Tom');
  const offered = (key: string) => new Set(registry.specsFor(tom, modes.get(key)).map((spec) => spec.name));
  for (const key of ['browser', 'social', 'finance']) {
    const names = offered(key);
    for (const name of ['browser.act', 'secrets.generate', 'secrets.list']) assert.ok(names.has(name), `${key} offers ${name}`);
  }
  for (const key of modes.list().map((mode) => mode.key)) {
    const names = offered(key);
    if (names.has('browser.act')) assert.ok(names.has('secrets.generate') && names.has('secrets.list'), `${key}: the vault comes with browser.act`);
  }
  const writing = offered('writing');
  assert.ok(!writing.has('browser.act'), 'no browser in writing mode');
  assert.ok(writing.has('secrets.list') && writing.has('secrets.generate'), 'the secrets catalog is in every mode');
});

function rig(run: () => Promise<ToolOutput>, extra: Partial<ToolDef> = {}) {
  const h = setup();
  const items: Array<{ id: string; kind: string; data: Record<string, unknown>; effectStatus?: string }> = [];
  h.services.runs = {
    item: (_runId: string, item: { kind: string; data: Record<string, unknown>; effectStatus?: string }) => { const row = { ...item, id: `ri_${items.length + 1}` }; items.push(row); return row; },
    updateItem: (id: string, patch: { data?: Record<string, unknown>; effectStatus?: string }) => {
      const row = items.find((entry) => entry.id === id)!;
      if (patch.data) row.data = patch.data; // replaces: the registry must send the whole call data again
      if (patch.effectStatus) row.effectStatus = patch.effectStatus;
    },
  } as unknown as RuntimeServices['runs'];
  const registry = new Registry({ services: () => h.services as RuntimeServices });
  registry.register(tool('shop.buy', 'spend', {
    describe: () => ({ summary: 'Pay 9 EUR with code sk-abc123', resource: 'https://shop.example.com/pay', reversible: false, external: true }),
    run: async () => run(),
    ...extra,
  } as Partial<ToolDef>));
  const base: Omit<ToolContext, 'services'> = { agent: h.org.require('ag_tom'), runId: 'run_1', conversationId: h.chat.id, mode: 'general', signal: new AbortController().signal, status: () => {} };
  const call = (callId: string) => registry.call('shop.buy', {}, base, callId);
  const callItem = (callId: string) => items.find((entry) => entry.kind === 'tool_call' && entry.data.callId === callId)!;
  return { h, call, callItem, items };
}

test('the journal redacts the summary and keeps the category after the settle update', async () => {
  const { call, callItem } = rig(async () => ({ content: [{ type: 'text', text: 'paid' }], effect: { status: 'confirmed', externalId: 'ord_1' } }));
  assert.equal((await call('c1')).isError, undefined);
  const item = callItem('c1');
  assert.equal(item.effectStatus, 'confirmed');
  assert.equal(item.data.summary, 'Pay 9 EUR with code secret://sec_1');
  assert.deepEqual([item.data.category, item.data.externalId], ['spend', 'ord_1']);
  assert.doesNotMatch(JSON.stringify(item.data), /sk-abc123/);
});

test('a throw is journaled unknown; a reported error or a failed effect stays failed', async () => {
  let answer: () => Promise<ToolOutput> = async () => { throw new Error('connection reset'); };
  const { call, callItem } = rig(() => answer());
  await call('c1');
  assert.equal(callItem('c1').effectStatus, 'unknown', 'it may have charged: verify before repeating');
  answer = async () => ({ content: [{ type: 'text', text: 'card declined' }], isError: true, effect: { status: 'failed' } });
  await call('c2');
  assert.equal(callItem('c2').effectStatus, 'failed');
  answer = async () => ({ content: [{ type: 'text', text: 'mailbox full' }], isError: true });
  await call('c3');
  assert.equal(callItem('c3').effectStatus, 'failed', 'a reported error is a failure');
});

