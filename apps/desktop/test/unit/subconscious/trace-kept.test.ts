// A kept trace: a turn that never reached its engine gives it back and the next turn shows it, also what that turn was "shown"
// already; a note or hit older than a day is dropped (also a row of 0.2.9 without a time), other calls stay.
// Owns: these assertions only. Never: real models or engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerSetup } from '../context/ledger-fixture.ts';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { SubconsciousImpl } from '../../../src/runtime/subconscious/service.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { SubconsciousTrace } from '../../../src/shared/model/subconscious.ts';
import { setup } from '../agents/fixture.ts';

const DAY = 24 * 60 * 60_000;
const NOTE: SubconsciousTrace = { calls: [{ tool: 'agent.tell', args: {}, output: 'Der Kunde wartet auf das Angebot.' }] };

function world() {
  const t = ledgerSetup();
  const impl = new SubconsciousImpl({ services: () => t.services, runner: false });
  const before = () => impl.beforeTurn({ agent: t.tom, thread: t.chat.id });
  return { t, impl, before };
}

test('a trace put back reaches the next turn once, although it counted as shown', async () => {
  const { t, impl, before } = world();
  try {
    impl.putBack(t.tom.id, t.chat.id, NOTE);
    const first = await before();
    assert.equal(first?.calls[0].output, NOTE.calls[0].output);
    impl.putBack(t.tom.id, t.chat.id, first!); // that turn failed before its engine
    const second = await before();
    assert.equal(second?.calls[0].output, NOTE.calls[0].output, 'not hidden as "shown within the hour"');
    assert.equal(await before(), undefined, 'taken: not a third time');
  } finally { t.cleanup(); }
});

test('a note or hit older than a day is dropped, also when a turn keeps failing; another call stays', async () => {
  const { t, impl, before } = world();
  try {
    impl.putBack(t.tom.id, t.chat.id, { calls: [
      ...NOTE.calls,
      { tool: 'vector.search', args: { query: 'x', in: ['memory'] }, output: 'h1 memory/a.md' },
      { tool: 'context.restore', args: { ids: ['t1'] }, output: 'restored' },
    ] });
    t.clock.advance(DAY - 1000);
    const kept = await before();
    assert.equal(kept?.calls.length, 3, 'younger than a day');
    impl.putBack(t.tom.id, t.chat.id, kept!);
    t.clock.advance(2000);
    assert.deepEqual((await before())?.calls.map((call) => call.tool), ['context.restore'], 'putting it back does not make it young again');
  } finally { t.cleanup(); }
});

test('a kept row of 0.2.9 has no time per call: its row\'s time counts', async () => {
  const { t, before } = world();
  try {
    const write = (at: number) => t.services.db.run(
      `INSERT INTO kv (ns, key, value, updated_at) VALUES ('subconscious_trace', ?, ?, ?) ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [`${t.tom.id}:${t.chat.id}`, JSON.stringify(NOTE), at]);
    write(t.clock.now() - 1000);
    assert.equal((await before())?.calls.length, 1);
    t.services.db.run(`DELETE FROM kv WHERE ns = 'subconscious_trace'`);
    write(t.clock.now() - DAY - 1000);
    assert.equal(await before(), undefined);
  } finally { t.cleanup(); }
});

function failing() {
  const h = setup();
  const back: Array<{ agentId: string; thread: string; trace: SubconsciousTrace }> = [];
  Object.assign(h.services.subconscious, {
    beforeTurn: async () => NOTE,
    putBack: (agentId: string, thread: string, trace: SubconsciousTrace) => { back.push({ agentId, thread, trace }); },
  });
  return { h, back };
}

test('routing fails before the engine: the trace goes back for the thread', async () => {
  const { h, back } = failing();
  Object.assign(h.services, { router: { route: async () => { throw new WorkforceError('unavailable', 'No model is connected.'); } } });
  const outcome = await new TurnExecutor(() => h.services).execute(h.request());
  assert.equal(outcome.status, 'failed');
  assert.deepEqual(back, [{ agentId: h.tom.id, thread: h.chat.id, trace: NOTE }]);
});

test('preparing the turn fails before the engine: the trace goes back too; a turn that ran keeps nothing', async () => {
  const { h, back } = failing();
  Object.assign(h.services, { router: { route: async () => h.route } });
  const get = h.services.accounts.get;
  Object.assign(h.services.accounts, { get: () => undefined }); // buildTurn: "The chosen account is not available."
  assert.equal((await new TurnExecutor(() => h.services).execute(h.request())).status, 'failed');
  assert.equal(back.length, 1);
  Object.assign(h.services.accounts, { get });
  assert.notEqual((await new TurnExecutor(() => h.services).execute(h.request({ runId: 'run_ran' }))).status, 'skipped');
  assert.equal(back.length, 1, 'it reached the engine');
});
