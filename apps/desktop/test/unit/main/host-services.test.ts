import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NavigateRequest } from '../../../src/shared/api/desktop.ts';
import type { HostOp, HostRequest } from '../../../src/shared/api/host-bridge.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { HostServices, navigateTarget } from '../../../src/main/host-services.ts';
import type { HostServicesDeps, NotificationLike } from '../../../src/main/host-services.ts';

class FakeNotification implements NotificationLike {
  readonly options: { title: string; body: string; silent: boolean };
  readonly handlers = new Map<string, () => void>();
  shown = false;
  closed = false;
  constructor(options: { title: string; body: string; silent: boolean }) { this.options = options; }
  on(event: 'click' | 'close' | 'failed', listener: () => void) { this.handlers.set(event, listener); return this; }
  show() { this.shown = true; }
  close() { this.closed = true; }
  fire(event: string) { this.handlers.get(event)?.(); }
}

function harness(overrides: Partial<HostServicesDeps> = {}) {
  const calls = { external: [] as string[], opened: [] as string[], revealed: [] as string[], shown: 0, beeps: 0, navigated: [] as NavigateRequest[], badge: [] as number[], stopped: [] as number[], badgeCount: [] as number[] };
  const notifications: FakeNotification[] = [];
  let focused = false;
  let backend = 'dpapi';
  let available = true;
  let blocker = 100;
  const deps: HostServicesDeps = {
    safeStorage: {
      isEncryptionAvailable: () => available,
      getSelectedStorageBackend: () => backend,
      encryptString: plain => Buffer.from(`enc:${plain}`),
      decryptString: cipher => cipher.toString().replace(/^enc:/, ''),
    },
    shell: {
      openExternal: async url => { calls.external.push(url); },
      openPath: async target => { calls.opened.push(target); return target.endsWith('missing') ? 'Failed to open path' : ''; },
      showItemInFolder: target => { calls.revealed.push(target); },
      beep: () => { calls.beeps++; },
    },
    idleSeconds: () => 42.7,
    powerSaveBlocker: { start: () => ++blocker, stop: id => { calls.stopped.push(id); return true; } },
    createNotification: options => { const n = new FakeNotification(options); notifications.push(n); return n; },
    setBadgeCount: count => { calls.badgeCount.push(count); return true; },
    capture: {
      screenshot: async target => ({ data: new Uint8Array([1]), width: target.window ? 10 : 20, height: 5, mime: 'image/png' }),
      displays: () => [{ index: 0, width: 1920, height: 1080, scale: 1, primary: true }],
    },
    window: { focused: () => focused, show: () => { calls.shown++; }, navigate: request => { calls.navigated.push(request); } },
    onBadge: count => { calls.badge.push(count); },
    setTimer: () => 'timer',
    clearTimer: () => {},
    ...overrides,
  };
  const host = new HostServices(deps);
  const call = <O extends HostOp>(op: O, args: unknown) => host.handle({ id: 1, type: 'host', op, args } as HostRequest);
  return {
    host, call, calls, notifications,
    setFocused: (value: boolean) => { focused = value; },
    setBackend: (value: string) => { backend = value; },
    setAvailable: (value: boolean) => { available = value; },
  };
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof WorkforceError && error.code === code);
}

test('safeStorage: round trip, refusal without a keyring (basic_text) or encryption', async () => {
  const h = harness();
  const { cipher } = await h.call('encrypt', { plain: 'sk-secret' }) as { cipher: Uint8Array };
  assert.ok(cipher instanceof Uint8Array);
  assert.deepEqual(await h.call('decrypt', { cipher }), { plain: 'sk-secret' });
  h.setBackend('basic_text');
  await rejectsWith(h.call('encrypt', { plain: 'x' }), 'unavailable');
  await rejectsWith(h.call('decrypt', { cipher }), 'unavailable');
  h.setBackend('gnome_libsecret');
  h.setAvailable(false);
  await rejectsWith(h.call('encrypt', { plain: 'x' }), 'unavailable');
  h.setAvailable(true);
  await rejectsWith(h.call('encrypt', { plain: 42 }), 'bad_request');
  await rejectsWith(h.call('decrypt', { cipher: 'not bytes' }), 'bad_request');
});

test('openExternal: only http(s) and mailto reach the shell', async () => {
  const h = harness();
  assert.deepEqual(await h.call('openExternal', { url: 'https://example.com/docs' }), { ok: true });
  assert.deepEqual(await h.call('openExternal', { url: 'mailto:team@example.com' }), { ok: true });
  for (const url of ['file:///C:/Windows/notepad.exe', 'javascript:alert(1)', 'ms-settings:', 'https://u:p@example.com']) {
    await rejectsWith(h.call('openExternal', { url }), 'forbidden');
  }
  assert.deepEqual(h.calls.external, ['https://example.com/docs', 'mailto:team@example.com']);
});

test('notify: click shows the window and navigates to the chat/task', async () => {
  const h = harness();
  const pending = h.call('notify', { title: 'Approval needed', body: 'Ada: send invoice', conversationId: 'ch_01jab3k9z7mx2c4q', taskId: 'task_01jab3k9z7mx2c4q' });
  await Promise.resolve();
  const [toast] = h.notifications;
  assert.ok(toast.shown);
  assert.equal(toast.options.silent, false);
  toast.fire('click');
  assert.deepEqual(await pending, { clicked: true });
  assert.equal(h.calls.shown, 1);
  assert.deepEqual(h.calls.navigated, [{ conversationId: 'ch_01jab3k9z7mx2c4q', taskId: 'task_01jab3k9z7mx2c4q' }]);
});

test('notify: close → not clicked; focused window → no OS toast; same tag replaces', async () => {
  const h = harness();
  const first = h.call('notify', { title: 'A', body: 'b', tag: 'task_01jab3k9z7mx2c4q' });
  await Promise.resolve();
  const second = h.call('notify', { title: 'A2', body: 'b2', tag: 'task_01jab3k9z7mx2c4q', silent: true });
  await Promise.resolve();
  assert.equal(h.notifications[0].closed, true, 'older toast with the same tag closed');
  assert.equal(h.notifications[1].options.silent, true);
  h.notifications[0].fire('close');
  assert.deepEqual(await first, { clicked: false });
  h.notifications[1].fire('click');
  assert.deepEqual(await second, { clicked: true });
  assert.deepEqual(h.calls.navigated, [{ taskId: 'task_01jab3k9z7mx2c4q' }], 'target derived from the tag');
  h.setFocused(true);
  assert.deepEqual(await h.call('notify', { title: 'x', body: 'y' }), { clicked: false });
  assert.equal(h.notifications.length, 2, 'no toast while the user looks at the app');
  await rejectsWith(h.call('notify', { title: 5, body: 'y' }), 'bad_request');
});

test('notify sound: a focused window beeps, a silent notification never; a burst sounds once in 3 s (a clock set back mutes nothing), also as OS toasts', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const h = harness();
  h.setFocused(true);
  assert.deepEqual(await h.call('notify', { title: 'Quiet chat', body: '', silent: true }), { clicked: false });
  assert.equal(h.calls.beeps, 0, 'silent (sound off, or the chat muted): no beep');
  for (const id of ['task_01jab3k9z7mx2c4a', 'task_01jab3k9z7mx2c4b', 'task_01jab3k9z7mx2c4c']) {
    assert.deepEqual(await h.call('notify', { title: 'To-do for you', body: id, tag: id }), { clicked: false });
  }
  assert.equal(h.calls.beeps, 1, 'three to-dos at once: one beep');
  assert.equal(h.notifications.length, 0, 'no OS toast while the window has focus');
  t.mock.timers.tick(3000);
  await h.call('notify', { title: 'Blocker', body: '' });
  assert.equal(h.calls.beeps, 2, '3 s later the next one beeps again');
  t.mock.timers.setTime(1_003_000 - 60_000); // the clock set back a minute
  await h.call('notify', { title: 'After a clock change', body: '' });
  assert.equal(h.calls.beeps, 3, 'a clock set back mutes nothing');

  h.setFocused(false);
  t.mock.timers.tick(3000);
  const pending = [h.call('notify', { title: 'Away 1', body: '' }), h.call('notify', { title: 'Away 2', body: '' })];
  await Promise.resolve();
  assert.deepEqual(h.notifications.map((toast) => toast.options.silent), [false, true], 'the first OS toast sounds, the next of the burst is quiet');
  assert.equal(h.calls.beeps, 3, 'an OS toast makes its own sound, no beep');
  for (const toast of h.notifications) toast.fire('close');
  assert.deepEqual(await Promise.all(pending), [{ clicked: false }, { clicked: false }]);
});

test('navigateTarget prefers explicit ids and ignores malformed ones', () => {
  assert.deepEqual(navigateTarget({ tag: 'ch_01jab3k9z7mx2c4q' }), { conversationId: 'ch_01jab3k9z7mx2c4q' });
  assert.deepEqual(navigateTarget({ conversationId: 'ch_01jab3k9z7mx2c4q', tag: 'task_01jab3k9z7mx2c4q' }), { conversationId: 'ch_01jab3k9z7mx2c4q' });
  assert.equal(navigateTarget({ conversationId: '../etc', tag: 'whatever' }), null);
});

test('openPath opens or reveals absolute paths only', async () => {
  const h = harness();
  assert.deepEqual(await h.call('openPath', { path: 'C:\\Users\\me\\Workforce\\report.pdf' }), { ok: true });
  assert.deepEqual(await h.call('openPath', { path: '/home/me/Workforce/a.png', reveal: true }), { ok: true });
  await rejectsWith(h.call('openPath', { path: 'relative/file.txt' }), 'bad_request');
  await rejectsWith(h.call('openPath', { path: '/tmp/missing' }), 'unavailable');
  assert.deepEqual(h.calls.revealed, ['/home/me/Workforce/a.png']);
});

test('keepAwake blockers are tracked and released with the runtime', async () => {
  const h = harness();
  const a = await h.call('keepAwake', { reason: 'render video' }) as { id: number };
  const b = await h.call('keepAwake', { reason: 'long run' }) as { id: number };
  assert.deepEqual(await h.call('releaseAwake', { id: a.id }), { ok: true });
  assert.deepEqual(await h.call('releaseAwake', { id: 9999 }), { ok: true }, 'unknown ids are ignored');
  h.host.releaseAll();
  assert.deepEqual(h.calls.stopped, [a.id, b.id]);
});

test('badge, idle, displays and screenshot ops', async () => {
  const h = harness();
  await h.call('setBadge', { count: 3.7 });
  await h.call('setBadge', { count: -5 });
  assert.deepEqual(h.calls.badge, [3, 0]);
  assert.deepEqual(h.calls.badgeCount, [3, 0]);
  assert.deepEqual(await h.call('idleSeconds', {}), { seconds: 42 });
  assert.equal(((await h.call('displays', {})) as { displays: unknown[] }).displays.length, 1);
  assert.equal(((await h.call('screenshot', { target: { window: 'app' } })) as { width: number }).width, 10);
  assert.equal(((await h.call('screenshot', { target: { display: 0 }, format: 'jpeg' })) as { width: number }).width, 20);
  await rejectsWith(h.call('screenshot', { target: { display: 'x' } }), 'bad_request');
  await rejectsWith(h.host.handle({ id: 2, type: 'host', op: 'nope' as HostOp, args: {} } as HostRequest), 'bad_request');
});

test('bytes sent to the runtime never drag a shared buffer pool along', async () => {
  const { ownBytes } = await import('../../../src/main/capture.ts');
  const pool = new Uint8Array(64).fill(7);
  const slice = pool.subarray(8, 12);
  const owned = ownBytes(slice);
  assert.equal(owned.buffer.byteLength, 4);
  assert.deepEqual([...owned], [7, 7, 7, 7]);
  const whole = new Uint8Array(4);
  assert.equal(ownBytes(whole).buffer, whole.buffer, 'no copy when the view owns its buffer');
  const h = harness();
  const { cipher } = await h.call('encrypt', { plain: 'abc' }) as { cipher: Uint8Array };
  assert.equal(cipher.buffer.byteLength, cipher.byteLength);
});
