// B-076: the mesh methods side.pull / side.pullPart / side.input / side.nav (src/runtime/devices/side-view.ts) serve this
// PC's side tabs only to the CEO's own PCs – an employee's PC, the employer this PC joined, an unknown or a revoked PC
// get 'forbidden' before anything happens; the input is checked and mapped here; a linked PC's caller (`via`) keeps its
// own part slot, and a forwarded frame travels in parts of at most 1 MiB whatever the caller asked for.
// Owns: these assertions only. Never: a real link, Electron or timers beyond the pulls' own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import type { PeerHandler } from '../../../src/runtime/devices/rpc-peer.ts';
import { SIDE_METHODS, registerSideView } from '../../../src/runtime/devices/side-view.ts';
import { sideViewOf } from '../../../src/runtime/browser/side-view.ts';
import type { HostOps } from '../../../src/shared/api/host-bridge.ts';
import { SIDE_PART_BYTES, type SidePull } from '../../../src/shared/model/side-view.ts';
import { record } from './sync-net.ts';
import { memoryDb } from './fakes.ts';

const TAB = 'web-1111';
const code = (error: unknown) => (error as { code?: string }).code;

function rig() {
  const db = memoryDb();
  const repo = new DevicesRepo(db);
  repo.upsert(record('dev_self', { self: true, name: 'office-pc' }));
  repo.upsert(record('dev_ceo'));
  repo.upsert(record('dev_emp', { personId: 'per_1' }));
  repo.upsert(record('dev_boss', { joinedAs: 'employee' }));
  repo.upsert(record('dev_gone', { status: 'revoked', revokedAt: 1 }));
  const navs: Array<HostOps['sideNav']['args']> = [];
  const inputs: Array<HostOps['sideInput']['args']> = [];
  const sideView = {
    cast: async () => ({ ok: true as const, page: { url: 'https://mail.example/', title: 'Mail', back: false, forward: false, loading: false } }),
    input: async (args: HostOps['sideInput']['args']) => { inputs.push(args); return { ok: true as const }; },
    nav: async (args: HostOps['sideNav']['args']) => { navs.push(args); return { ok: true as const }; },
  };
  const services = { db, host: { sideView }, devices: { self: () => ({ id: 'dev_self', name: 'office-pc' }) } } as unknown as RuntimeServices;
  const handlers = new Map<string, PeerHandler>();
  registerSideView({ register: (method, handler) => { handlers.set(method, handler); } }, () => services);
  const call = (method: string, params: unknown, from: string) => handlers.get(method)!(params, from, new AbortController().signal);
  return { services, handlers, call, navs, inputs };
}

test('all four methods are registered, and only the CEO\'s own PCs reach them', async () => {
  const r = rig();
  assert.deepEqual([...r.handlers.keys()].sort(), [...SIDE_METHODS].sort());
  for (const from of ['dev_emp', 'dev_boss', 'dev_gone', 'dev_unknown', 'dev_self']) {
    for (const [method, params] of [
      ['side.nav', { tab: TAB, action: 'reload' }], ['side.input', { tab: TAB, input: { kind: 'text', text: 'x' } }],
      ['side.pull', { tab: TAB }], ['side.pullPart', { tab: TAB, at: 1, index: 1 }],
    ] as const) {
      await assert.rejects(r.call(method, params, from), (error: unknown) => code(error) === 'forbidden', `${method} from ${from}`);
    }
  }
  assert.deepEqual([r.navs.length, r.inputs.length], [0, 0], 'nothing happened for them');
  assert.deepEqual(await r.call('side.nav', { tab: TAB, action: 'reload' }, 'dev_ceo'), { ok: true });
  assert.deepEqual(await r.call('side.nav', { tab: TAB, dialog: 'accept' }, 'dev_ceo'), { ok: true }); // the page's dialog answered from there
  assert.deepEqual(r.navs, [{ tab: TAB, action: 'reload' }, { tab: TAB, dialog: 'accept' }]);
});

test('input from a CEO PC is checked and mapped here, never taken as DevTools commands', async () => {
  const r = rig();
  await assert.rejects(r.call('side.input', { tab: TAB, input: { kind: 'eval', text: 'x' } }, 'dev_ceo'), (error: unknown) => code(error) === 'bad_request');
  await assert.rejects(r.call('side.input', { tab: TAB, commands: [{ method: 'Runtime.evaluate' }] }, 'dev_ceo'), (error: unknown) => code(error) === 'bad_request');
  await assert.rejects(r.call('side.input', { tab: 'web-x/../y', input: { kind: 'text', text: 'x' } }, 'dev_ceo'), (error: unknown) => code(error) === 'bad_request');
  await r.call('side.input', { tab: TAB, input: { kind: 'key', type: 'down', key: 'Enter', code: 'Enter' } }, 'dev_ceo');
  assert.deepEqual(r.inputs.map((i) => i.commands.map((c) => c.method)), [['Input.dispatchKeyEvent']]);
});

test('a forwarded pull keeps the linked PC\'s caller slot and travels in parts of at most 1 MiB', async () => {
  const r = rig();
  const big = 'x'.repeat(SIDE_PART_BYTES + 1000);
  const first = await r.call('side.pull', { tab: TAB, via: 'dev_phone' }, 'dev_ceo') as SidePull;
  assert.equal(first.state.pc, 'office-pc');
  sideViewOf(r.services).update({ tab: TAB, live: true, page: first.state, frame: { data: big, meta: { deviceWidth: 1280, deviceHeight: 800, offsetTop: 0, pageScaleFactor: 1, zoom: 1 } } });
  const reply = await r.call('side.pull', { tab: TAB, via: 'dev_phone', after: { state: first.state.at }, maxBytes: 4 * 1024 * 1024 }, 'dev_ceo') as SidePull;
  assert.equal(reply.parts, 2);
  assert.equal(reply.frame?.data.length, SIDE_PART_BYTES);
  const part = await r.call('side.pullPart', { tab: TAB, via: 'dev_phone', at: reply.frame!.at, index: 1 }, 'dev_ceo') as { data: string };
  assert.equal(reply.frame!.data + part.data, big);
  await assert.rejects(r.call('side.pullPart', { tab: TAB, at: reply.frame!.at, index: 1 }, 'dev_ceo'), (error: unknown) => code(error) === 'not_found', 'the PC\'s owner has a slot of its own');
  await assert.rejects(r.call('side.pull', { tab: TAB, via: 'not a caller!' }, 'dev_ceo'), (error: unknown) => code(error) === 'bad_request');
});
