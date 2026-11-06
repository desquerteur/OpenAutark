// F07 recorder devices and take guard: the remembered camera/microphone is preferred and falls
// back to the system default when it is gone; a camera plugged in while a preview is live is
// pre-selected on 'devicechange', one plugged in meanwhile at the next preview – without a live
// preview a change neither arms media nor chooses; one device per kind never shows a choice
// (virtual 'default' microphones are left out); the guard reports 'busy' while recording or
// with a take, keeps held items inside Home's limit and discards every widget's take on one key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addedDevices, createDeviceChooser, deviceConstraint, devicesOf, discardTake, heldTakes, holdTake, limitKeepingHeld,
  preferredDevice, realDevice, releaseTake, rememberDevice, rememberedDevice, takeBusy,
} from '../../../src/ui/blocks/ui/media-devices.ts';
import type { DeviceChoice, DeviceInfo, StorageLike } from '../../../src/ui/blocks/ui/media-devices.ts';
import { TAKE_MAX_AGE_MS, isStaleTake } from '../../../src/ui/pwa/idb.ts';

const cam = (id: string, label = id, groupId = `g-${id}`): DeviceInfo => ({ deviceId: id, kind: 'videoinput', label, groupId });
const mic = (id: string, label = id, groupId = `g-${id}`): DeviceInfo => ({ deviceId: id, kind: 'audioinput', label, groupId });

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => { data[key] = value; } };
}

function fakeMedia(initial: DeviceInfo[]) {
  let devices = initial;
  const listeners = new Set<() => void>();
  const fake = {
    listeners,
    /** No access right now (desktop: the arm from the click ran out): ids and names are hidden. */
    withheld: false,
    media: {
      enumerateDevices: async () => (fake.withheld ? devices.map((device) => ({ ...device, deviceId: '', label: '' })) : devices),
      addEventListener: (_type: 'devicechange', listener: () => void) => { listeners.add(listener); },
      removeEventListener: (_type: 'devicechange', listener: () => void) => { listeners.delete(listener); },
    },
    /** The OS reports a change (a camera plugged in or out, headphones, a virtual camera). */
    change(next: DeviceInfo[]) { devices = next; for (const listener of [...listeners]) listener(); },
  };
  return fake;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function chooser(mode: 'audio' | 'video', devices: DeviceInfo[], options: { storage?: StorageLike; remembered?: boolean } = {}) {
  const fake = fakeMedia(devices);
  const changes: Array<{ choice: DeviceChoice; switched: boolean }> = [];
  const arms: string[][] = [];
  const instance = createDeviceChooser(mode, {
    media: fake.media, storage: options.storage ?? memoryStorage(), remembered: options.remembered,
    arm: async (kinds) => { arms.push(kinds); fake.withheld = false; },
    onChange: (choice, switched) => changes.push({ choice, switched }),
  });
  return { fake, changes, instance, arms };
}

test('device lists leave out entries without access and the virtual default microphones', () => {
  const all = [mic('default', 'Default - Headset', 'g-head'), mic('communications', 'Communications - Headset', 'g-head'), mic('m1', 'Headset', 'g-head'), cam('c1', ''), { deviceId: '', kind: 'videoinput', label: '' }];
  assert.deepEqual(devicesOf(all, 'audio'), [{ id: 'm1', label: 'Headset' }], 'one microphone gives no choice');
  assert.deepEqual(devicesOf(all, 'video'), [{ id: 'c1', label: 'Camera 1' }], 'an unnamed camera gets a plain label');
  assert.equal(realDevice(all, 'audio', 'default'), 'm1', "Chromium's 'default' is the real device of the same group");
  assert.equal(realDevice(all, 'audio', 'm1'), 'm1');
  assert.equal(realDevice([mic('default')], 'audio', 'default'), undefined, 'no real device behind it');
  assert.equal(realDevice(all, 'audio', undefined), undefined);
});

test('the remembered device is preferred and falls back to the default when it is gone', () => {
  const devices = devicesOf([cam('c1'), cam('usb')], 'video');
  assert.equal(preferredDevice(devices, 'usb'), 'usb');
  assert.equal(preferredDevice(devices, 'gone'), undefined, 'the system default');
  assert.equal(preferredDevice(devices, undefined), undefined);
  assert.deepEqual(deviceConstraint('usb'), { deviceId: { exact: 'usb' } }, 'the selected device must actually be used');
  assert.deepEqual(deviceConstraint(undefined), {});
});

test('the choice is remembered per mode; blocked storage never throws', () => {
  const storage = memoryStorage();
  rememberDevice('video', 'usb', storage);
  rememberDevice('audio', 'm2', storage);
  assert.equal(rememberedDevice('video', storage), 'usb');
  assert.equal(rememberedDevice('audio', storage), 'm2');
  assert.deepEqual(storage.data, { 'wf.recorder.device.video': 'usb', 'wf.recorder.device.audio': 'm2' }, 'only device ids are kept');
  const blocked: StorageLike = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceededError'); } };
  assert.doesNotThrow(() => rememberDevice('video', 'usb', blocked));
  assert.equal(rememberedDevice('video', blocked), undefined);
  assert.equal(rememberedDevice('video', null), undefined);
});

test('after access the chooser lists the devices, shows the one in use and prefers the remembered one', async () => {
  const storage = memoryStorage({ 'wf.recorder.device.video': 'usb' });
  const h = chooser('video', [cam('builtin'), cam('usb')], { storage });
  assert.equal(h.instance.wanted(), 'usb', 'the first stream asks for the remembered camera');
  assert.equal(h.fake.listeners.size, 0, 'nothing is listened to before access was allowed');
  await h.instance.refresh('usb');
  assert.deepEqual(h.instance.choice.devices.map((device) => device.id), ['builtin', 'usb']);
  assert.equal(h.instance.choice.selected, 'usb');
  assert.equal(h.fake.listeners.size, 1, 'devicechange is listened to from now on');

  const gone = chooser('video', [cam('builtin')], { storage });
  await gone.instance.refresh('builtin');
  assert.equal(gone.instance.choice.selected, 'builtin', 'the remembered camera is unplugged: the default is shown');
  assert.equal(storage.data['wf.recorder.device.video'], 'usb', 'and stays remembered for when it is back');
});

test('devicechange with a new camera pre-selects and remembers it ("New camera found")', async () => {
  const storage = memoryStorage();
  const h = chooser('video', [cam('builtin')], { storage });
  await h.instance.refresh('builtin');
  h.fake.change([cam('builtin'), cam('usb', 'Logitech C920')]);
  await settle();
  assert.deepEqual(h.arms, [], 'the names were readable: nothing is armed');
  const last = h.changes.at(-1)!;
  assert.equal(last.switched, true, 'a live preview switches to it');
  assert.equal(last.choice.selected, 'usb');
  assert.equal(last.choice.added, 'usb');
  assert.equal(last.choice.devices.length, 2, 'two cameras: the select appears');
  assert.equal(storage.data['wf.recorder.device.video'], 'usb');
  assert.equal(h.instance.wanted(), 'usb');

  h.instance.choose('builtin');
  assert.equal(h.instance.choice.selected, 'builtin', 'the person can still pick the other one');
  assert.equal(h.instance.choice.added, undefined, 'the "New camera found" note goes');
  assert.equal(storage.data['wf.recorder.device.video'], 'builtin');
  h.instance.choose('unknown');
  assert.equal(h.instance.choice.selected, 'builtin', 'an unknown id is ignored');
});

test('an unplugged chosen device switches back to the default; a new microphone is not forced', async () => {
  const h = chooser('video', [cam('builtin'), cam('usb')]);
  await h.instance.refresh('usb');
  h.fake.change([cam('builtin')]);
  await settle();
  assert.deepEqual(h.changes.at(-1), { choice: { devices: [{ id: 'builtin', label: 'builtin' }], selected: undefined, added: undefined }, switched: true });

  const audio = chooser('audio', [mic('m1')]);
  await audio.instance.refresh('m1');
  audio.fake.change([mic('m1'), mic('bt', 'Bluetooth headset')]);
  await settle();
  const last = audio.changes.at(-1)!;
  assert.equal(last.switched, false);
  assert.equal(last.choice.selected, 'm1', 'only cameras are pre-selected when plugged in');
  assert.equal(last.choice.devices.length, 2);
});

test('names withheld on a change keep the last list; dispose stops listening', async () => {
  const h = chooser('video', [cam('builtin'), cam('usb')]);
  await h.instance.refresh('builtin');
  const before = h.changes.length;
  h.fake.change([{ deviceId: '', kind: 'videoinput', label: '' }]);
  await settle();
  assert.deepEqual(h.arms, [['video']], 'asked once to read the cameras again');
  assert.equal(h.changes.length, before, 'nothing changes while access is not allowed');
  assert.equal(h.instance.choice.devices.length, 2);
  h.instance.dispose();
  assert.equal(h.fake.listeners.size, 0);
  await h.instance.refresh('usb');
  assert.equal(h.changes.length, before, 'a disposed chooser reports nothing');
});

test('a live preview whose names are withheld on a change arms only the listed kind', async () => {
  const h = chooser('video', [cam('builtin')]);
  await h.instance.refresh('builtin');
  h.fake.withheld = true;
  h.fake.change([cam('builtin'), cam('usb')]);
  await settle();
  assert.deepEqual(h.arms, [['video']], 'the cameras only – never the microphone for a camera list');
  assert.equal(h.instance.choice.selected, 'usb', 'listed again after the arm: the new camera is found');

  const audio = chooser('audio', [mic('m1')]);
  await audio.instance.refresh('m1');
  audio.fake.withheld = true;
  audio.fake.change([mic('m1'), mic('bt')]);
  await settle();
  assert.deepEqual(audio.arms, [['audio']]);
});

test('without a live preview a device change neither arms nor chooses; the next preview catches up', async () => {
  const storage = memoryStorage();
  const h = chooser('video', [cam('builtin')], { storage });
  await h.instance.refresh('builtin');
  h.instance.pause(); // Cancel, Record, a take waiting, an error: the stream is closed or busy
  assert.equal(h.fake.listeners.size, 0, 'not listening while idle');
  const before = h.changes.length;
  h.fake.withheld = true;
  h.fake.change([cam('builtin'), cam('usb', 'Logitech C920')]); // headphones, a virtual camera, a plug
  await settle();
  assert.deepEqual(h.arms, [], 'no media arm without a click');
  assert.equal(h.changes.length, before, 'no quiet choice');
  assert.equal(storage.data['wf.recorder.device.video'], undefined, 'nothing is remembered quietly');

  h.fake.withheld = false; // the next "Start camera" or Retake (a click arms) opens the old camera
  await h.instance.refresh('builtin');
  assert.deepEqual(h.changes.at(-1), { choice: { devices: [{ id: 'builtin', label: 'builtin' }, { id: 'usb', label: 'Logitech C920' }], selected: 'usb', added: 'usb' }, switched: true },
    'the camera that came meanwhile is pre-selected ("New camera found") and the preview switches to it');
  assert.equal(storage.data['wf.recorder.device.video'], 'usb');
  assert.equal(h.fake.listeners.size, 1, 'listening again while the preview is live');
  await h.instance.refresh('usb');
  assert.equal(h.changes.at(-1)!.switched, false, 'the reopened preview is on it: no loop');
});

test('a pause while a list is on its way drops it', async () => {
  const h = chooser('video', [cam('builtin')]);
  const listing = h.instance.refresh('builtin');
  h.instance.pause(); // Record pressed before the list came back
  await listing;
  assert.equal(h.fake.listeners.size, 0, 'no listener after the pause');
  assert.equal(h.changes.length, 0);

  const storage = memoryStorage();
  const live = chooser('video', [cam('builtin')], { storage });
  await live.instance.refresh('builtin');
  const before = live.changes.length;
  live.fake.change([cam('builtin'), cam('usb')]);
  live.instance.pause(); // the change was still being listed
  await settle();
  assert.equal(live.changes.length, before, 'the change is dropped');
  assert.equal(storage.data['wf.recorder.device.video'], undefined);
});

test('a block asking for a front/back camera does not start from the remembered one', async () => {
  const storage = memoryStorage({ 'wf.recorder.device.video': 'usb' });
  const h = chooser('video', [cam('front'), cam('back')], { storage, remembered: false });
  assert.equal(h.instance.wanted(), undefined, 'facingMode decides the first stream');
  await h.instance.refresh('back');
  assert.equal(h.instance.choice.selected, 'back');
  assert.equal(h.instance.wanted(), 'back', 'a retake keeps the camera in use');
});

test('addedDevices needs a known list first', () => {
  const after = devicesOf([cam('a'), cam('b')], 'video');
  assert.deepEqual(addedDevices([], after), [], 'the first listing finds nothing "new"');
  assert.deepEqual(addedDevices(devicesOf([cam('a')], 'video'), after).map((device) => device.id), ['b']);
});

test('the take guard is busy while recording or with a take', () => {
  assert.equal(takeBusy('recording', false), true);
  assert.equal(takeBusy('recorded', true), true);
  assert.equal(takeBusy('recorded', false), false);
  for (const state of ['idle', 'preparing', 'ready', 'error'] as const) assert.equal(takeBusy(state, false), false, state);
});

test('held takes: two widgets on one key, release and discard', () => {
  const discarded: string[] = [];
  const a = {};
  const b = {};
  holdTake('task_1', a, () => discarded.push('a'));
  holdTake('task_1', b, () => discarded.push('b'));
  holdTake('task_2', a, () => discarded.push('a2'));
  assert.deepEqual([...heldTakes.value].sort(), ['task_1', 'task_2']);
  releaseTake('task_1', a);
  assert.ok(heldTakes.value.has('task_1'), 'still held by the other widget');
  releaseTake('task_1', a);
  discardTake('task_1');
  assert.deepEqual(discarded, ['b'], 'every widget still holding the key drops its take');
  releaseTake('task_1', b);
  releaseTake('task_2', a);
  assert.equal(heldTakes.value.size, 0);
  assert.doesNotThrow(() => discardTake('task_9'), 'no widget and no IndexedDB here: nothing to do');
});

test("Home's limit keeps a held item in order", () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  assert.deepEqual(limitKeepingHeld(items, 5, () => false), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(limitKeepingHeld(items, 5, (item) => item === 'g'), ['a', 'b', 'c', 'd', 'e', 'g']);
  assert.deepEqual(limitKeepingHeld(items, undefined, () => false), items);
});

test('stored takes older than a week count as stale', () => {
  const now = 1_000_000_000_000;
  assert.equal(isStaleTake({ at: now - 1000 }, now), false);
  assert.equal(isStaleTake({ at: now - TAKE_MAX_AGE_MS - 1 }, now), true);
  assert.equal(isStaleTake({}, now), true, 'no time: dropped');
  assert.equal(isStaleTake(null, now), true);
});
