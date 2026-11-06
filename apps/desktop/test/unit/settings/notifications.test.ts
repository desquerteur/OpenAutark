// Tests for the notification service (src/runtime/notify/service.ts): the global push filter
// (enabled, pushFor, sound, quiet hours in the profile timezone), de-duplication, extra channels,
// and the per-chat level and sound (C3, notify/levels.ts) with the bus event's toast flag.
// Owns: these assertions only. Never: real OS notifications or push services.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationSettings } from '../../../src/shared/model/chat.ts';
import type { EventMap } from '../../../src/shared/api/events.ts';
import { Notifications, inQuietHours } from '../../../src/runtime/notify/service.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { clock, memoryDb, recordingBus } from '../store/helpers.ts';

function setup() {
  const db = memoryDb();
  const recorder = recordingBus();
  const time = clock(); // 2026-10-17 09:00 UTC = 11:00 Europe/Berlin
  const settings = new SettingsStore({ db, bus: recorder.bus, clock: time, env: { locale: 'en-US', timezone: 'Europe/Berlin' } });
  const pushed: Array<{ title: string; silent?: boolean; tag?: string }> = [];
  const host = { notify: async (input: { title: string; body: string; silent?: boolean; tag?: string }) => { pushed.push(input); return false; } };
  /** Chat settings by conversation id (the composition root looks them up in the chat service). */
  const chats = new Map<string, ConversationSettings>();
  const service = new Notifications({
    bus: recorder.bus, host, settings, clock: time, log: new MemoryLogger(),
    chat: (id) => { if (id === 'ch_broken') throw new Error('db closed'); const found = chats.get(id); return found ? { settings: found } : undefined; },
  });
  const toasts = () => recorder.of('notify').map((note) => [(note as EventMap['notify']).title, (note as EventMap['notify']).toast]);
  return { service, settings, pushed, time, chats, toasts, ...recorder };
}

test('by default: todo/blocker/important push with a sound, done/reply/info only go to the bus', () => {
  const { service, settings, pushed, of } = setup();
  assert.equal(settings.get().notifications.sound, true, 'sound is on by default');
  for (const kind of ['todo', 'blocker', 'important', 'done', 'reply', 'info'] as const) {
    service.notify({ kind, title: kind, body: 'x', taskId: `task_${kind}` });
  }
  assert.equal(of('notify').length, 6);
  assert.deepEqual(pushed.map((entry) => entry.title), ['todo', 'blocker', 'important']);
  assert.deepEqual(pushed.map((entry) => entry.silent), [false, false, false]);
  assert.equal(pushed[0].tag, 'task_todo');
});

test('pushFor, enabled and sound settings decide replies and finished work; to-dos, blockers and important always push (B-078)', () => {
  const { service, settings, pushed } = setup();
  settings.update({ notifications: { pushFor: ['done'], sound: false } });
  service.notify({ kind: 'todo', title: 'a', body: '' });
  service.notify({ kind: 'done', title: 'b', body: '' });
  service.notify({ kind: 'reply', title: 'r', body: '' });
  assert.deepEqual(pushed.map((entry) => [entry.title, entry.silent]), [['a', true], ['b', true]]);
  settings.update({ notifications: { enabled: false } });
  service.notify({ kind: 'done', title: 'c', body: '' });
  service.notify({ kind: 'blocker', title: 'd', body: '' });
  service.notify({ kind: 'important', title: 'e', body: '' });
  assert.deepEqual(pushed.map((entry) => entry.title), ['a', 'b', 'd', 'e'], 'an old "off" never silences what needs the person');
});

test('quiet hours in the profile timezone suppress replies and finished work (also across midnight), never a to-do', () => {
  const { service, settings, pushed, time } = setup();
  settings.update({ notifications: { quietHours: { from: '10:30', to: '12:00' }, pushFor: ['todo', 'done'] } }); // now 11:00 Berlin
  service.notify({ kind: 'done', title: 'quiet', body: '' });
  service.notify({ kind: 'todo', title: 'needs you', body: '', taskId: 'task_q' });
  assert.deepEqual(pushed.map((entry) => entry.title), ['needs you']);
  time.advance(60 * 60 * 1000); // 12:00 Berlin → outside
  service.notify({ kind: 'done', title: 'loud', body: '' });
  assert.equal(pushed.length, 2);
  const at = Date.UTC(2026, 9, 17, 22, 30); // 00:30 Berlin
  assert.equal(inQuietHours(at, 'Europe/Berlin', { from: '22:00', to: '07:00' }), true);
  assert.equal(inQuietHours(at, 'UTC', { from: '23:00', to: '07:00' }), false);
  assert.equal(inQuietHours(at, 'Europe/Berlin', { from: '07:00', to: '07:00' }), false);
});

test('extra channels receive allowed pushes, can be removed, and failures are isolated', async () => {
  const { service, pushed } = setup();
  const received: string[] = [];
  const remove = service.addChannel((input) => { received.push(input.title); });
  service.addChannel(() => { throw new Error('broken channel'); });
  service.addChannel(async () => { throw new Error('async broken'); });
  service.notify({ kind: 'blocker', title: 'one', body: '' });
  service.notify({ kind: 'info', title: 'never', body: '' });
  remove();
  service.notify({ kind: 'important', title: 'two', body: '' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, ['one']);
  assert.equal(pushed.length, 2);
});

test('same kind+tag within 3 s is pushed once', () => {
  const { service, pushed, time } = setup();
  service.notify({ kind: 'todo', title: 'a', body: '', taskId: 'task_1' });
  service.notify({ kind: 'todo', title: 'b', body: '', taskId: 'task_1' });
  time.advance(3000);
  service.notify({ kind: 'todo', title: 'c', body: '', taskId: 'task_1' });
  assert.deepEqual(pushed.map((entry) => entry.title), ['a', 'c']);
});

test('a chat set to Off blocks replies, results, important messages and blockers – pushes and toasts – but not to-dos and approvals', () => {
  const { service, settings, chats, pushed, toasts } = setup();
  settings.update({ notifications: { pushFor: ['todo', 'blocker', 'important', 'done', 'reply'] } });
  chats.set('ch_off', { notifications: 'off' });
  for (const kind of ['reply', 'done', 'important', 'blocker', 'info', 'todo'] as const) {
    service.notify({ kind, title: kind, body: '', conversationId: 'ch_off', taskId: `task_${kind}` });
  }
  service.notify({ kind: 'todo', title: 'Approval needed', body: 'Tom: send the mail', conversationId: 'ch_off' });
  assert.deepEqual(pushed.map((entry) => entry.title), ['todo', 'Approval needed']);
  assert.deepEqual(toasts(), [
    ['reply', false], ['done', false], ['important', false], ['blocker', false], ['info', false], ['todo', true], ['Approval needed', true],
  ]);
  assert.equal(service.shouldPush({ kind: 'done', conversationId: 'ch_off' }), false);
  assert.equal(service.shouldPush({ kind: 'done' }), true, 'without the chat the global settings decide');
});

test('"Mentions and tasks" passes important messages (@person), to-dos and blockers; replies and results stay quiet', () => {
  const { service, settings, chats, pushed, toasts } = setup();
  settings.update({ notifications: { pushFor: ['todo', 'blocker', 'important', 'done', 'reply'] } });
  chats.set('ch_m', { notifications: 'mentions' });
  for (const kind of ['reply', 'done', 'important', 'blocker', 'todo'] as const) {
    service.notify({ kind, title: kind, body: '', conversationId: 'ch_m', taskId: `task_${kind}` });
  }
  assert.deepEqual(pushed.map((entry) => entry.title), ['important', 'blocker', 'todo']);
  assert.deepEqual(toasts().map(([, toast]) => toast), [false, false, true, true, true]);
});

test('per-chat sound off makes the push silent even when sound is on globally', () => {
  const { service, settings, chats, pushed } = setup();
  settings.update({ notifications: { sound: true } });
  chats.set('ch_quiet', { sound: false });
  chats.set('ch_loud', { sound: true });
  service.notify({ kind: 'todo', title: 'quiet', body: '', conversationId: 'ch_quiet' });
  service.notify({ kind: 'todo', title: 'loud', body: '', conversationId: 'ch_loud' });
  service.notify({ kind: 'todo', title: 'global', body: '' });
  assert.deepEqual(pushed.map((entry) => [entry.title, entry.silent]), [['quiet', true], ['loud', false], ['global', false]]);
  settings.update({ notifications: { sound: false } });
  service.notify({ kind: 'blocker', title: 'a chat cannot make it loud', body: '', conversationId: 'ch_loud' });
  assert.equal(pushed.at(-1)?.silent, true);
});

test('"All messages" pushes and toasts replies and results past pushFor, still within enabled and quiet hours', () => {
  const { service, settings, chats, pushed, toasts } = setup();
  chats.set('ch_all', { notifications: 'all' });
  service.notify({ kind: 'reply', title: 'reply', body: '', conversationId: 'ch_all' });
  service.notify({ kind: 'done', title: 'done', body: '', conversationId: 'ch_all' });
  service.notify({ kind: 'reply', title: 'default chat', body: '', conversationId: 'ch_other' });
  assert.deepEqual(pushed.map((entry) => entry.title), ['reply', 'done']);
  assert.deepEqual(toasts(), [['reply', true], ['done', true], ['default chat', false]]);
  settings.update({ notifications: { quietHours: { from: '10:00', to: '12:00' } } }); // now 11:00 Berlin
  service.notify({ kind: 'reply', title: 'quiet hours', body: '', conversationId: 'ch_all', taskId: 'task_q' });
  settings.update({ notifications: { quietHours: { from: '00:00', to: '00:00' }, enabled: false } });
  service.notify({ kind: 'reply', title: 'disabled', body: '', conversationId: 'ch_all', taskId: 'task_d' });
  assert.equal(pushed.length, 2);
});

test('the toast flag without a chat level: everything but info and replies; a failing chat lookup falls back to the global settings', () => {
  const { service, pushed, toasts } = setup();
  for (const kind of ['todo', 'blocker', 'important', 'done', 'reply', 'info'] as const) service.notify({ kind, title: kind, body: '', taskId: `task_${kind}` });
  assert.deepEqual(toasts().map(([, toast]) => toast), [true, true, true, true, false, false]);
  service.notify({ kind: 'todo', title: 'broken lookup', body: '', conversationId: 'ch_broken' });
  assert.equal(pushed.at(-1)?.title, 'broken lookup');
  assert.equal(service.shouldPush({ kind: 'todo', conversationId: 'ch_broken' }), true);
});
