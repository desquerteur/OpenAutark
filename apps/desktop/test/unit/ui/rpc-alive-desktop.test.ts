// The desktop window keeps its MessagePort as it was (lib/rpc.ts): the liveness check of the
// phone/browser socket (checkAlive, rpc-alive.test.ts) sends no probe over the port and opens no
// second port on visible, pageshow, online or a push – the bridge reports a restarted runtime itself.
// A file of its own: platform.ts decides desktop or phone once per process.
// Owns: these assertions only. Never: a real runtime or Electron.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

test('desktop: visible, pageshow, online and a push leave the runtime port alone', async (t) => {
  const globals = globalThis as Record<string, unknown>;
  const saved = { window: globals.window, document: globals.document };
  const channel = new MessageChannel();
  let connects = 0;
  const windowListeners = new Map<string, () => void>();
  const docListeners = new Map<string, () => void>();
  globals.window = {
    workforce: {
      platform: 'win32',
      connect: () => { connects += 1; return Promise.resolve(channel.port1); },
      onRuntime: () => () => undefined,
    },
    addEventListener: (type: string, fn: () => void) => { windowListeners.set(type, fn); },
    removeEventListener: () => undefined,
  };
  globals.document = { visibilityState: 'visible', addEventListener: (type: string, fn: () => void) => { docListeners.set(type, fn); } };
  t.after(() => {
    // Not closed: a closed port makes the client retry forever once `window` is gone; unref lets the process end.
    (channel.port1 as unknown as { unref(): void }).unref(); // Node's MessagePort has unref; the DOM type does not
    (channel.port2 as unknown as { unref(): void }).unref();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
  });

  const { platform } = await import('../../../src/ui/lib/platform.ts');
  const { rpc, checkAlive } = await import('../../../src/ui/lib/rpc.ts');
  assert.equal(platform, 'desktop');
  rpc.start();
  for (let i = 0; i < 3 && rpc.status.value !== 'open'; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rpc.status.value, 'open');

  docListeners.get('visibilitychange')?.();
  windowListeners.get('pageshow')?.();
  windowListeners.get('online')?.();
  checkAlive(); // what a push ('wf.wake') runs
  void rpc.call('devices.list').catch(() => undefined);
  const [frame] = (await once(channel.port2, 'message')) as [{ method?: string }];
  assert.equal(frame.method, 'devices.list', 'the first frame on the port is the real call: no probe went before it');
  assert.equal(connects, 1, 'no second port');
  assert.equal(rpc.status.value, 'open');
});
