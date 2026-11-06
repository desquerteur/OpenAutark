// SG – quiet routing lines: a switch line leads with the hint deviation; without a switch a
// deviation from the chat's hint is noted once as "Kept …" ("Using …" on a first turn) and not
// repeated until the situation changes; no hint deviation → exactly the old behaviour (a line only on
// a switch, nothing remembered). B-044 removed the soft guide's notes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { deviation, routeLines } from '../../../src/runtime/agents/route-line.ts';
import type { RouteDecision } from '../../../src/shared/model/providers.ts';

function rig() {
  const db = new Db(':memory:');
  migrate(db);
  const services = { db, clock: new ManualClock(Date.UTC(2026, 9, 23)), log: { warn() {}, info() {}, debug() {}, error() {} } } as never;
  return { db, services };
}

const scope = { agentId: 'ag_1', conversationId: 'ch_1' };
const route = (patch: Partial<RouteDecision>): RouteDecision => ({
  modelId: 'codex:gpt-6.1-sol', engine: 'codex', accountId: 'acc', effort: 'medium', category: 'chat', reason: 'chat · best fit', by: 'rules', alternatives: [], ...patch,
});
const weakHint = { modelId: 'claude:claude-haiku-5-5', taken: false, why: 'suggested Claude Haiku 5.5 is weak at video animation' };

test('a switch line leads with the hint deviation', () => {
  const { services } = rig();
  const lines = routeLines(services, scope, route({ reason: `${weakHint.why} · video animation · strongest fit`, hint: weakHint }), 'GPT-6.1 Sol', { modelId: 'claude:claude-haiku-5-5', effort: 'medium' });
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /^Switched to GPT-6\.1 Sol · medium — suggested Claude Haiku 5\.5 is weak at video animation/);
  assert.ok(lines[0].text.length <= 120);
  assert.deepEqual(lines[0].details.hint, weakHint);
});

test('no switch: a deviation is noted once ("Kept …"), again only after it changed or was resolved', () => {
  const { services, db } = rig();
  const from = { modelId: 'codex:gpt-6.1-sol', effort: 'medium' as const };
  const kept = route({ hint: weakHint });
  assert.deepEqual(routeLines(services, scope, kept, 'GPT-6.1 Sol', from).map((line) => line.text), ['Kept GPT-6.1 Sol · medium — suggested Claude Haiku 5.5 is weak at video animation']);
  assert.deepEqual(routeLines(services, scope, kept, 'GPT-6.1 Sol', from), [], 'not every turn');
  assert.deepEqual(routeLines(services, { ...scope, conversationId: 'ch_2' }, kept, 'GPT-6.1 Sol', from).length, 1, 'per chat');
  // The hint is taken now: nothing to say, the marker is cleared – a later deviation is noted again.
  assert.deepEqual(routeLines(services, scope, route({ hint: { modelId: weakHint.modelId, taken: true } }), 'GPT-6.1 Sol', from), []);
  assert.equal(routeLines(services, scope, kept, 'GPT-6.1 Sol', from).length, 1);
  // A first turn says "Using".
  const first = routeLines(services, { agentId: 'ag_9', conversationId: 'ch_1' }, route({ hint: weakHint }), 'Qwen', undefined);
  assert.deepEqual(first.map((line) => line.text), ['Using Qwen · medium — suggested Claude Haiku 5.5 is weak at video animation']);
  assert.ok(db.get('SELECT value FROM kv WHERE ns = ? AND key = ?', ['route_line', 'ag_9:ch_1']));
});

test('without a hint deviation: the old switch line only, nothing remembered', () => {
  const { services, db } = rig();
  assert.deepEqual(routeLines(services, scope, route({}), 'GPT-6.1 Sol', undefined), []);
  assert.deepEqual(routeLines(services, scope, route({}), 'GPT-6.1 Sol', { modelId: 'codex:gpt-6.1-sol', effort: 'medium' }), []);
  const switched = routeLines(services, scope, route({ effort: 'high' }), 'GPT-6.1 Sol', { modelId: 'codex:gpt-6.1-sol', effort: 'medium' });
  assert.deepEqual(switched.map((line) => line.text), ['Switched to GPT-6.1 Sol · high — best fit for chat']);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM kv WHERE ns = ?', ['route_line'])?.n, 0);
  assert.equal(deviation(route({ hint: { modelId: 'x', taken: true } })), undefined);
});
