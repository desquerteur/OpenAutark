// B-055 Q8 named pointers: an agent's click in its own browser reports its pointer (surface agent:<id>/<tab>, with
// the ref and the thinned path) and the line about the others there is appended to its results; RPC
// pointers.point / pointers.list: the owner everywhere, a person of the organisation only in their chats'
// browsers, phones never, the actor always the caller, at most ~10 points per second per actor.

import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { browserTools } from '../../../src/runtime/browser/tools.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { scopeDenial, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { PointerHub } from '../../../src/runtime/pointers/hub.ts';
import { resetPointerThrottle, THROTTLE_MS } from '../../../src/runtime/pointers/rpc.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import { topicOf } from '../../../src/shared/api/events.ts';
import { isTopic, maySubscribe } from '../../../src/runtime/rpc/scopes.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolDef } from '../../../src/runtime/tools/types.ts';
import { cleanupB055, scriptBrowser, textOf, toolCtx } from '../browser/b055-fakes.ts';

after(cleanupB055);
beforeEach(resetPointerThrottle);

const tool = (tools: ToolDef[], name: string) => tools.find((entry) => entry.name === name)!;

test('an agent\'s click reports its named pointer; results name the others on that tab', async () => {
  const { browser, page } = scriptBrowser();
  const tools = browserTools(browser);
  const { ctx, pointers, advance } = toolCtx();
  await tool(tools, 'browser.open').run({ url: 'https://shop.test/' }, ctx);
  const p = page();
  p.snapshot = '- button "Pay" [ref=e31]';
  await tool(tools, 'browser.snapshot').run({}, ctx);
  p.boxes.set('aria-ref=e31', { x: 300, y: 100, width: 80, height: 30 });
  await tool(tools, 'browser.act').run({ action: 'click', ref: 'e31' }, ctx);
  const [mine] = pointers.on('agent:ag_ada/t1');
  assert.deepEqual({ ...mine, path: undefined }, {
    surface: 'agent:ag_ada/t1', actor: { kind: 'agent', id: 'ag_ada', name: 'Ada' }, x: 340, y: 115, action: 'click',
    target: { ref: 'e31' }, path: undefined, at: 1_000_000,
  });
  assert.ok(mine!.path!.length >= 2 && mine!.path!.length <= 40, 'the thinned glide path travels with it');
  assert.deepEqual(mine!.path!.at(-1), { x: 340, y: 115, t: mine!.path!.at(-1)!.t });
  // The person points at the same button: the agent reads it in its next result there (not about itself).
  pointers.point({ surface: 'agent:ag_ada/t1', actor: { kind: 'person', id: 'human', name: 'Lukas' }, x: 341, y: 116, target: { role: 'button', name: 'Pay', ref: 'e31' } });
  advance(2000);
  const text = textOf(await tool(tools, 'browser.snapshot').run({}, ctx));
  assert.match(text, /\n\nLukas \(person\) is pointing at button "Pay" \[ref=e31\], 2 s ago$/);
  assert.ok(!text.includes('Ada (agent)'), 'never the agent itself');
  await browser.close();
});

function rpc(options: { scope: ClientScope; now?: () => number }) {
  const pointers = new PointerHub({ now: options.now });
  const people = { caller: () => ({ id: 'per_lukas00001', name: 'Lukas', scopes: {}, status: 'active' }) };
  const services = {
    pointers, people,
    clock: { now: options.now ?? (() => 5000) },
    settings: { get: () => ({ profile: { name: 'Maria' } }) },
    db: { get: (_sql: string, params: unknown[]) => (params[0] === 'ch_1' && params[1] === 'per_lukas00001' ? { conversation_id: 'ch_1', joined_at: 1, read_seq: 0 } : undefined) },
    chats: {
      get: (id: string) => ({ id, settings: {} }),
      members: (id: string) => (id === 'ch_people' ? [{ memberId: 'per_lukas00001' }] : [{ memberId: 'human' }]),
    },
  } as unknown as RuntimeServices;
  const ctx = { scope: options.scope, services, extras: {}, topics: new Set(), signal: new AbortController().signal } as unknown as HandlerContext;
  const table = createHandlerTable();
  const call = (method: string, params: unknown) => table.get(method)!.handler(params as never, ctx);
  return { pointers, call, table };
}

test('rpc pointers.point: the owner points as themself (profile name) on any surface, the throttle keeps ~10/s', async () => {
  let now = 5000;
  const { pointers, call } = rpc({ scope: { kind: 'owner' }, now: () => now });
  assert.deepEqual(await call('pointers.point', { surface: 'agent:ag_ada/t1', x: 10.5, y: 20, action: 'move', target: { role: 'link', name: 'Docs' } }), { ok: true, kept: true });
  assert.deepEqual(await call('pointers.point', { surface: 'agent:ag_ada/t1', x: 11, y: 21 }), { ok: true, kept: false }, 'within the throttle');
  now += THROTTLE_MS;
  assert.deepEqual(await call('pointers.point', { surface: 'side:web-1', x: 1, y: 2 }), { ok: true, kept: true });
  assert.deepEqual(pointers.on('agent:ag_ada/t1').map((p) => [p.actor, p.x, p.target]), [[{ kind: 'person', id: 'human', name: 'Maria' }, 10.5, { role: 'link', name: 'Docs' }]]);
  const listed = await call('pointers.list', { surface: 'side:web-1' }) as { surface: string; points: unknown[] };
  assert.equal(listed.points.length, 1);
  await assert.rejects(Promise.resolve().then(() => call('pointers.point', { surface: 'nowhere', x: 1, y: 1 })), /Invalid parameter "surface"/);
  await assert.rejects(Promise.resolve().then(() => call('pointers.point', { surface: 'side:web-1', x: 1, y: 1, actor: { name: 'Fake' } })), /params\.actor/, 'the actor is never the client\'s');
});

test('rpc pointers.point: a person only in the browsers of their chats; phones never', async () => {
  const { pointers, call, table } = rpc({ scope: { kind: 'person', personId: 'per_lukas00001', deviceId: 'dev_lu', tokenId: 'tok', secure: true } });
  assert.deepEqual(await call('pointers.point', { surface: 'chat:ch_1/t2', x: 5, y: 6, action: 'click' }), { ok: true, kept: true });
  assert.deepEqual(pointers.on('chat:ch_1/t2')[0]!.actor, { kind: 'person', id: 'per_lukas00001', name: 'Lukas' });
  await assert.rejects(Promise.resolve().then(() => call('pointers.point', { surface: 'chat:ch_2/t1', x: 5, y: 6 })), /You can point only in the browsers of your chats/);
  await assert.rejects(Promise.resolve().then(() => call('pointers.list', { surface: 'agent:ag_ada/t1' })), /You can point only in the browsers of your chats/);
  const phone: ClientScope = { kind: 'device', deviceId: 'dev_phone', capabilities: ['todo', 'chat', 'tasks', 'settings', 'manage', 'permissions'], secure: true };
  for (const method of ['pointers.point', 'pointers.list']) assert.equal(scopeDenial(table.get(method)!.scope, phone), 'scope', method);
});

