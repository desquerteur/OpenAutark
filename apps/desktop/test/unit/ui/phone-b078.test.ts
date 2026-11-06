// B-078 phone UI: Back layer by layer (ui/pwa/back.ts nextBack), the sideways swipe between a chat and its area
// (ui/workspace/phone-swipe.ts swipeTurn), the Android app's mark (ui/pwa/native.ts) and the phone's words in Settings ›
// Devices (ui/settings/connect-text.ts).
// Owns: these assertions. Never: renders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextBack } from '../../../src/ui/pwa/back.ts';
import { isAndroidApp } from '../../../src/ui/pwa/native.ts';
import { EDGE_PX, OWNS_SIDEWAYS, swipeTurn } from '../../../src/ui/workspace/phone-swipe.ts';
import { incomingText, phoneDot, phoneQrHint, PHONE_IN_USE_MS } from '../../../src/ui/settings/connect-text.ts';
import type { RemoteIncoming } from '../../../src/shared/model/remote.ts';

const none = { overlay: false, sheet: false, area: false };

test('Back closes layers first, then goes up, and is done on My day', () => {
  assert.equal(nextBack({ view: 'chat', id: 'c1' }, { ...none, overlay: true, sheet: true }), 'overlay');
  assert.equal(nextBack({ view: 'chat', id: 'c1' }, { ...none, sheet: true, area: true }), 'sheet');
  assert.equal(nextBack({ view: 'chat', id: 'c1' }, { ...none, area: true }), 'area');
  assert.equal(nextBack({ view: 'chat', id: 'c1' }, { ...none, panel: true, area: true }), 'panel', 'the thread or details sheet closes before the chat is left');
  assert.equal(nextBack({ view: 'chat', id: 'c1' }, { ...none, sheet: true, panel: true }), 'sheet');
  assert.deepEqual(nextBack({ view: 'chat', id: 'c1' }, none), { view: 'chats' });
  assert.deepEqual(nextBack({ view: 'team', agentId: 'ag_1' }, none), { view: 'team' });
  assert.deepEqual(nextBack({ view: 'tasks', task: 'tk_1' }, none), { view: 'tasks' });
  assert.deepEqual(nextBack({ view: 'settings', section: 'devices' }, none), { view: 'settings' });
  assert.deepEqual(nextBack({ view: 'settings' }, none), { view: 'home' });
  assert.deepEqual(nextBack({ view: 'chats' }, none), { view: 'home' });
  assert.deepEqual(nextBack({ view: 'team' }, none), { view: 'home' });
  assert.equal(nextBack({ view: 'home' }, none), false);
  assert.equal(nextBack({ view: 'day' }, none), false);
});

test('a swipe counts only away from the edges, clearly sideways and long enough', () => {
  const width = 400;
  assert.equal(swipeTurn({ x: 300, y: 300 }, { x: 200, y: 310 }, width), 'area', 'towards the left: the area');
  assert.equal(swipeTurn({ x: 100, y: 300 }, { x: 200, y: 290 }, width), 'messages', 'towards the right: the messages');
  assert.equal(swipeTurn({ x: EDGE_PX - 1, y: 300 }, { x: 200, y: 300 }, width), null, 'the left edge is the system Back');
  assert.equal(swipeTurn({ x: width - EDGE_PX + 1, y: 300 }, { x: 200, y: 300 }, width), null, 'the right edge too');
  assert.equal(swipeTurn({ x: 300, y: 300 }, { x: 260, y: 300 }, width), null, 'too short');
  assert.equal(swipeTurn({ x: 300, y: 300 }, { x: 200, y: 400 }, width), null, 'more down than sideways');
  assert.ok(OWNS_SIDEWAYS.includes('[role="application"]') && OWNS_SIDEWAYS.includes('.browser-touch'), 'a drag in the mirrored PC browser stays with the page');
});

test('the Android app is told by its user agent', () => {
  assert.equal(isAndroidApp('Mozilla/5.0 (Linux; Android 15) Chrome/140 Mobile Safari/537.36 AutarkAndroid/0.3.3'), true);
  assert.equal(isAndroidApp('Mozilla/5.0 (Linux; Android 15) Chrome/140 Mobile Safari/537.36'), false);
});

test('Settings › Devices: the phone asks in its own words; its dot needs no switch', () => {
  const phone = { role: 'phone', name: 'Pixel 8', code: '4821' } as unknown as RemoteIncoming;
  assert.deepEqual(incomingText(phone), { label: 'Phone Pixel 8 asks to connect', hint: 'Accept only if the phone shows the code 4821' });
  assert.deepEqual(incomingText({ role: 'employee', name: 'Tower', code: '1234' }), { label: 'Tower wants to connect as an employee', hint: 'Accept only if Tower shows the code 1234' });
  assert.match(phoneQrHint(false), /Autark app on Android: scan this or type the Remote ID/);
  assert.match(phoneQrHint(true), /I was invited/);
  assert.equal(phoneDot({ lastSeenAt: 1_000 }, 1_000 + PHONE_IN_USE_MS - 1), 'online');
  assert.equal(phoneDot({ lastSeenAt: 1_000 }, 1_000 + PHONE_IN_USE_MS), 'offline');
  assert.equal(phoneDot({}), 'offline');
});
