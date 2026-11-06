// B-078 (D6): phone use through the Android app – AppPhones sends one request per step on the bus and takes only the
// asked phone's answer (20 s timeout, the run's cancel); drivers.ts sends a step to the app phone or to ADB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppPhones, PHONE_USE_OFF, safeNode } from '../../../src/runtime/phone/app-driver.ts';
import { mergedPhones } from '../../../src/runtime/phone/drivers.ts';
import type { PhoneUseRequest } from '../../../src/shared/api/methods-phone.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { HandTimers } from '../remote/rig.ts';
import { recordingBus } from '../devices/fakes.ts';

function rig() {
  const { bus } = recordingBus();
  const timers = new HandTimers();
  const phones = new AppPhones({ bus, devices: () => [{ id: 'dev_phone0000001', name: 'Pixel 8' } as never], timers });
  const requests: PhoneUseRequest[] = [];
  bus.on('phoneUse.request', (request) => requests.push(request));
  const reply = (deviceId: string, id: string, body: { result?: unknown; error?: { code: string; message: string } }) => bus.emit('phoneUse.reply', { deviceId, id, ...body });
  bus.emit('phoneUse.attached', { deviceId: 'dev_phone0000001', on: true, model: 'Pixel 8', ready: true });
  return { bus, phones, requests, reply, timers };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a step goes to the attached phone and comes back with its answer only', async () => {
  const { phones, requests, reply } = rig();
  assert.deepEqual(await phones.devices(), [{ serial: 'dev_phone0000001', state: 'device', model: 'Pixel 8', transport: 'autark-app' }]);
  const tap = phones.tap(undefined, 10.4, 20.6);
  await tick();
  assert.deepEqual(requests[0].op, 'tap');
  assert.deepEqual(requests[0].args, { x: 10, y: 21 });
  reply('dev_other000001', requests[0].id, { result: {} }); // another phone cannot answer it
  reply('dev_phone0000001', requests[0].id, { result: {} });
  await tap;

  const tree = phones.uiTree();
  await tick();
  reply('dev_phone0000001', requests[1].id, { result: { nodes: [
    { depth: 0, parent: -1, cls: 'FrameLayout', bounds: [0, 0, 1080, 2400] },
    { depth: 1, parent: 0, cls: 'Button', text: 'Send', clickable: true, bounds: [100, 200, 300, 260], extra: 'x' },
  ], screen: { width: 1080, height: 2400 } } });
  const read = await tree;
  assert.equal(read.serial, 'dev_phone0000001');
  assert.match(read.text, /Button "Send" \(tap\) @200,230/);
  assert.deepEqual(read.screen, { width: 1080, height: 2400 });
});

test('phone use off, a pause on the phone, the timeout and the run\'s cancel each end a step', async () => {
  const { phones, requests, reply, timers } = rig();
  const off = phones.key(undefined, 'back');
  await tick();
  reply('dev_phone0000001', requests[0].id, { error: { code: 'off', message: 'x' } });
  await assert.rejects(off, (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable' && error.message === PHONE_USE_OFF);

  const paused = phones.type(undefined, 'hi');
  await tick();
  reply('dev_phone0000001', requests[1].id, { error: { code: 'paused', message: 'The person paused phone use for 30 s.' } });
  await assert.rejects(paused, /paused phone use/);

  const slow = phones.open(undefined, { package: 'com.whatsapp' });
  await tick();
  timers.fire(20_000);
  await assert.rejects(slow, (error: unknown) => error instanceof WorkforceError && error.code === 'timeout');

  const abort = new AbortController();
  const cancelled = phones.swipe(undefined, { x: 1, y: 2 }, { x: 3, y: 4 }, 300, { signal: abort.signal });
  abort.abort();
  await assert.rejects(cancelled, (error: unknown) => error instanceof WorkforceError && error.code === 'cancelled');
});

test('a phone that goes offline ends its open steps and leaves the list', async () => {
  const { bus, phones } = rig();
  const shot = phones.screenshot();
  await tick();
  bus.emit('phoneUse.attached', { deviceId: 'dev_phone0000001', on: false });
  await assert.rejects(shot, /went offline/);
  assert.deepEqual(await phones.devices(), []);
  await assert.rejects(phones.tap(undefined, 1, 1), (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable');
});

test('drivers: a step without a serial goes to the app phone while ADB has none ready; a serial picks its phone', async () => {
  const { phones } = rig();
  const adbCalls: string[] = [];
  const adb = {
    available: async () => true,
    devices: async () => [] as never[],
    screenshot: async () => { adbCalls.push('screenshot'); return {} as never; },
    uiTree: async () => ({}) as never,
    tap: async (serial: string | undefined) => { adbCalls.push(`tap ${serial}`); },
    swipe: async () => undefined, type: async () => undefined, key: async () => 'KEYCODE_BACK', open: async () => '',
    pair: async () => ({ address: '' }), connect: async () => ({ address: '', already: false }), disconnect: async () => ({ serial: '', was: false }), discover: async () => [],
  };
  const merged = mergedPhones(adb, phones);
  assert.deepEqual((await merged.devices()).map((device) => device.serial), ['dev_phone0000001']);
  await merged.tap('192.168.1.20:5555', 1, 1);
  assert.deepEqual(adbCalls, ['tap 192.168.1.20:5555'], 'an ADB serial goes to ADB');
  assert.equal(await merged.available(), true);
});

test('safeNode keeps order and parents honest and drops what uiautomator does not know', () => {
  assert.deepEqual(safeNode({ parent: 5, text: 'a'.repeat(400), bounds: [0, 0, 10, 10], clickable: 'yes' }, 2), { index: 2, depth: 0, parent: -1, text: 'a'.repeat(300), bounds: [0, 0, 10, 10] });
  assert.deepEqual(safeNode(null, 0), { index: 0, depth: 0, parent: -1 });
});
