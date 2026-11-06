// Shared fakes for the device / PWA / computer / browser / phone / feedback /
// customize unit tests. No real processes, network or keychain.

import { Bus } from '../../../src/runtime/bus.ts';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import type { Host } from '../../../src/runtime/host.ts';
import type { Logger } from '../../../src/runtime/contracts.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';

export function memoryDb(): Db {
  const db = new Db(':memory:');
  migrate(db);
  return db;
}

export interface FakeHost extends Host {
  opened: string[];
  notified: Array<{ title: string; body: string }>;
  idle: number;
}

export function fakeHost(): FakeHost {
  const host: FakeHost = {
    kind: 'node',
    opened: [],
    notified: [],
    idle: 60,
    // Reversible "encryption" marked with a prefix so tests can see it is not plain text.
    encrypt: async (plain) => Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('base64')}`),
    decrypt: async (cipher) => {
      const text = Buffer.from(cipher).toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('not encrypted');
      return Buffer.from(text.slice(4), 'base64').toString('utf8');
    },
    notify: async (input) => { host.notified.push(input); return false; },
    openExternal: async (url) => { host.opened.push(url); },
    openPath: async () => {},
    onPower: () => () => {},
    idleSeconds: async () => host.idle,
    keepAwake: () => () => {},
    app: { version: '0.2.0-test', packaged: false, resourcesDir: '.', dataDir: '.', executable: process.execPath },
  };
  return host;
}

export const silentLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export function recordingBus(): { bus: Bus; events: Array<{ event: string; data: unknown }> } {
  const bus = new Bus((error) => { throw error; });
  const events: Array<{ event: string; data: unknown }> = [];
  bus.onAny((event, data) => events.push({ event, data }));
  return { bus, events };
}

export { ManualClock };
