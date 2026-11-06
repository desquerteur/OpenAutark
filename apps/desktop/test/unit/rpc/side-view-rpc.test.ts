// B-076: the RPC side.* (src/runtime/rpc/handlers/side-view.ts): without `device`, or with this PC's own id, a call
// serves this PC's tabs; with another PC's id it goes over the link (devices.call) with the caller here as `via` – the
// owner or the phone's id – and frames in parts of at most 1 MiB; input is checked before anything leaves; a reply
// without a state is refused. The owner and a phone holding 'todo' on a secure transport reach them, nobody else.
// Owns: these assertions only. Never: a real link, Electron or a socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../../../src/runtime/rpc/handlers/side-view.ts';
import { HandlerTable, scopeDenial, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import type { HostOps } from '../../../src/shared/api/host-bridge.ts';
import { SIDE_PART_BYTES } from '../../../src/shared/model/side-view.ts';

const TAB = 'web-2222';
const OWNER: ClientScope = { kind: 'owner' } as ClientScope;
const PHONE: ClientScope = { kind: 'device', deviceId: 'dev_phone', capabilities: ['todo', 'chat'], secure: true } as ClientScope;
const code = (error: unknown) => (error as { code?: string }).code;

function rig(reply: unknown = { state: { tab: TAB, pc: 'other-pc', at: 5 } }) {
  const table = new HandlerTable();
  register(table);
  const calls: Array<{ device: string; method: string; params: unknown }> = [];
  const navs: Array<HostOps['sideNav']['args']> = [];
  const casts: Array<HostOps['sideCast']['args']> = [];
  const services = {
    devices: {
      self: () => ({ id: 'dev_self', name: 'office-pc' }),
      call: async (device: string, method: string, params: unknown) => { calls.push({ device, method, params }); return method === 'side.pullPart' ? { data: 'PART' } : method === 'side.pull' ? reply : { ok: true }; },
    },
    host: {
      sideView: {
        cast: async (args: HostOps['sideCast']['args']) => { casts.push(args); return { ok: true as const, page: { url: 'https://a.example/', title: 'A', back: false, forward: false, loading: false } }; },
        input: async () => ({ ok: true as const }),
        nav: async (args: HostOps['sideNav']['args']) => { navs.push(args); return { ok: true as const }; },
      },
    },
  } as unknown as RuntimeServices;
  const run = async (method: string, params: unknown, scope: ClientScope = OWNER): Promise<unknown> => {
    const ctx = { scope, services, extras: {} as never, topics: new Set(), signal: new AbortController().signal, secure: true } as unknown as HandlerContext;
    return table.get(method)!.handler(params as never, ctx);
  };
  return { table, run, calls, navs, casts };
}

test('without device, or with this PC\'s own id, the call stays on this PC', async () => {
  const r = rig();
  await r.run('side.nav', { tab: TAB, action: 'reload' });
  await r.run('side.nav', { device: 'dev_self', tab: TAB, url: 'example.com' });
  await r.run('side.nav', { tab: TAB, dialog: 'accept' }); // the page's dialog answered
  assert.deepEqual(r.navs, [{ tab: TAB, action: 'reload' }, { tab: TAB, url: 'example.com' }, { tab: TAB, dialog: 'accept' }]);
  const pulled = await r.run('side.pull', { device: 'dev_self', tab: TAB }) as { state: { pc: string; url: string } };
  assert.deepEqual([pulled.state.pc, pulled.state.url], ['office-pc', 'https://a.example/']);
  assert.deepEqual(r.casts, [{ tab: TAB, on: true }]);
  assert.equal(r.calls.length, 0, 'nothing went over the link');
});

test('with another PC\'s id it goes over the link, the caller as via and parts of at most 1 MiB', async () => {
  const r = rig();
  const reply = await r.run('side.pull', { device: 'dev_b', tab: TAB, after: { state: 3 }, maxBytes: 4 * 1024 * 1024 });
  assert.deepEqual(reply, { state: { tab: TAB, pc: 'other-pc', at: 5 } });
  assert.deepEqual(r.calls[0], { device: 'dev_b', method: 'side.pull', params: { tab: TAB, after: { state: 3, frame: undefined }, maxBytes: SIDE_PART_BYTES, waitMs: undefined, via: 'owner' } });
  await r.run('side.pullPart', { device: 'dev_b', tab: TAB, at: 5, index: 1 }, PHONE);
  assert.deepEqual(r.calls[1], { device: 'dev_b', method: 'side.pullPart', params: { tab: TAB, at: 5, index: 1, via: 'dev_phone' } });
  await r.run('side.input', { device: 'dev_b', tab: TAB, input: { kind: 'text', text: 'hi' } }, PHONE);
  assert.deepEqual(r.calls[2], { device: 'dev_b', method: 'side.input', params: { tab: TAB, input: { kind: 'text', text: 'hi' } } });
  await r.run('side.nav', { device: 'dev_b', tab: TAB, action: 'back' });
  assert.deepEqual(r.calls[3], { device: 'dev_b', method: 'side.nav', params: { tab: TAB, action: 'back' } });
  await r.run('side.nav', { device: 'dev_b', tab: TAB, dialog: 'dismiss' });
  assert.deepEqual(r.calls[4], { device: 'dev_b', method: 'side.nav', params: { tab: TAB, dialog: 'dismiss' } });
  assert.equal(r.casts.length + r.navs.length, 0, 'nothing ran here');
});

test('bad input never leaves this PC; a reply without a state is refused', async () => {
  const r = rig({ nope: true });
  await assert.rejects(r.run('side.input', { device: 'dev_b', tab: TAB, input: { kind: 'text', text: 'a\u0007b' } }), (error: unknown) => code(error) === 'bad_request');
  await assert.rejects(r.run('side.input', { device: 'dev_b', tab: 't9', input: { kind: 'text', text: 'x' } }), (error: unknown) => code(error) === 'bad_request');
  await assert.rejects(r.run('side.nav', { device: 'dev_b', tab: TAB, url: 'a', action: 'back' }), (error: unknown) => code(error) === 'bad_request');
  assert.equal(r.calls.length, 0);
  await assert.rejects(r.run('side.pull', { device: 'dev_b', tab: TAB }), (error: unknown) => code(error) === 'unavailable');
});

test('the owner and a phone holding todo on a secure transport reach side.*; a plain LAN phone, a person or a peer do not', () => {
  const r = rig();
  for (const method of ['side.pull', 'side.pullPart', 'side.input', 'side.nav']) {
    const rule = r.table.get(method)!.scope;
    const shape: unknown = rule; // compared without narrowing the rule's type
    assert.deepEqual(shape, { capability: 'todo', secure: true }, method);
    assert.equal(scopeDenial(rule, OWNER), undefined);
    assert.equal(scopeDenial(rule, PHONE), undefined);
    assert.equal(scopeDenial(rule, { ...PHONE, secure: false } as ClientScope), 'insecure');
    assert.equal(scopeDenial(rule, { kind: 'person', personId: 'per_1', deviceId: 'd' } as unknown as ClientScope), 'scope');
    assert.equal(scopeDenial(rule, { kind: 'peer', deviceId: 'dev_b' } as unknown as ClientScope), 'scope');
  }
});
