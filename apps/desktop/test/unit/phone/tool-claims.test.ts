// Wave-7 follow-ups in the phone tools and AdbPhone (PH2): honest `reversible` claims (pairing,
// connecting, typing, swiping, links and confirming keys are not reversible; phone.key is judged
// on the mapped keycode, so "KEYCODE_ENTER", " enter", "center" and "space" are not moving keys),
// phone.disconnect believes the device list rather than adb's answer, and a probe does not ask
// `adb devices` again for every phone it just listed.
// Owns: these assertions only. Never: runs adb.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneTools } from '../../../src/runtime/phone/tools.ts';
import { movingKey } from '../../../src/runtime/phone/adb-args.ts';
import { AdbPhone, type ExecResult } from '../../../src/runtime/phone/adb.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { fakeAdb, out } from './fakes.ts';

const ctx = { status: () => undefined } as unknown as ToolContext;

test('reversible claims: only looking, listing, disconnecting and moving keys', () => {
  const tools = new Map(phoneTools({} as never).map((tool) => [tool.name, tool]));
  const claim = (name: string, args: Record<string, unknown> = {}) => tools.get(name)!.describe!(args as never, ctx).reversible;
  for (const name of ['phone.devices', 'phone.screenshot', 'phone.ui_tree']) assert.equal(claim(name), true, name);
  assert.equal(claim('phone.disconnect', { serial: '192.168.1.20:37099' }), true);
  assert.equal(claim('phone.pair', { address: '192.168.1.30:37005', code: '123456' }), false, 'a pairing stays on the phone');
  assert.equal(claim('phone.connect', { address: 'evil.example.com:5555' }), false);
  assert.equal(claim('phone.tap', { x: 1, y: 2 }), false);
  assert.equal(claim('phone.swipe', { x1: 1, y1: 2, x2: 3, y2: 4 }), false, 'swipe-to-delete');
  assert.equal(claim('phone.type', { text: 'hello there' }), false, 'types into whatever has focus');
  assert.equal(claim('phone.open', { url: 'https://wa.me/1?text=hi' }), false);
  for (const key of ['back', 'HOME', 'recents', 'tab', 'up', 'left', 'page_down', 'escape', 'KEYCODE_BACK', 'move_end', 'wakeup']) assert.equal(claim('phone.key', { key }), true, key);
  for (const key of ['enter', 'KEYCODE_ENTER', ' enter', 'center', 'KEYCODE_DPAD_CENTER', 'space', 'delete', 'del', 'backspace', 'forward_delete', 'menu', 'search', 'power', '']) {
    assert.equal(claim('phone.key', { key }), false, key);
  }
  assert.equal(movingKey(undefined as never), false);
});

test('phone.disconnect believes the device list: a phone adb did not let go is still reported as connected', async () => {
  const mdns = 'adb-R58N123-AbCdEf._adb-tls-connect._tcp';
  const { phone } = fakeAdb([
    (args) => (args[0] === 'disconnect' ? out(`error: no such device '${args[1]}'`) : undefined),
    (args) => (args[0] === 'devices' ? out(`List of devices attached\n${mdns}. device product:a52 model:SM_A525F transport_id:5\n`) : undefined),
  ]);
  const disconnect = phoneTools(phone).find((tool) => tool.name === 'phone.disconnect')!;
  const text = (output: unknown) => (output as { content: Array<{ text: string }> }).content[0].text;
  assert.match(text(await disconnect.run({ serial: mdns }, ctx)), /is still connected \(adb did not disconnect it\)/);
  assert.match(text(await disconnect.run({ serial: '192.168.1.20:37099' }, ctx)), /^192\.168\.1\.20:37099 was not connected\./);
});

test('a probe describes the phones it just listed without another `adb devices` each; later steps ask again', async () => {
  let now = 1_000;
  const calls: string[][] = [];
  const exec = async (_command: string, args: string[]): Promise<ExecResult> => {
    calls.push(args);
    const text = args[0] === 'devices' ? 'List of devices attached\nA device model:One\nB device model:Two\nC unauthorized\n' : args.includes('getprop') ? '[ro.product.model]: [Pixel]\n' : '';
    return { code: 0, stdout: new Uint8Array(Buffer.from(text)), stderr: '' };
  };
  const phone = new AdbPhone({ log: new MemoryLogger(), exec, now: () => now, finder: { find: async () => ({ command: 'adb', prefixArgs: [], path: 'adb' }) } });
  const listings = () => calls.filter((args) => args[0] === 'devices').length;
  await phone.devices();
  await phone.key('A', 'back');
  await phone.key('B', 'back');
  assert.equal(listings(), 1, 'one listing for the whole probe');
  await assert.rejects(phone.key('C', 'back'), /accept the debugging prompt/, 'a phone that is not ready is asked again');
  assert.equal(listings(), 2);
  now += 1_000;
  await phone.key('A', 'back');
  assert.equal(listings(), 3, 'an older list is not reused');
  await phone.disconnect('192.168.1.20:37099').catch(() => undefined);
  await phone.key('A', 'back');
  assert.equal(listings(), 4, 'a disconnect drops the reused list');
});
