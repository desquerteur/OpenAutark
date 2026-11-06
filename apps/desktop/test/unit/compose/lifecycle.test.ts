// The runtime's start and stop steps (runtime/compose/lifecycle.ts) exactly as main.ts runs
// them: the restore at start gives the host more time and brings a backup's workspace skills back
// (MM8); the stop runs every step in order, each awaited, past failures – the sign-ins (PR4), the
// connectors and the device connections (before the peer listener) included – and the database closes last.
// Owns: these assertions only. Never: a whole runtime, network, real CLIs or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AccountServiceImpl } from '../../../src/runtime/accounts/service.ts';
import { restoreAtStart, runStopSteps, stopSteps } from '../../../src/runtime/compose/lifecycle.ts';
import type { Network } from '../../../src/runtime/compose/network.ts';
import type { Core } from '../../../src/runtime/compose/services.ts';
import { RESTORE_MARKER } from '../../../src/runtime/portability/restore.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { portabilityFixture } from '../portability/fixture.ts';

const RESTORE_FAILED = 'restore-failed.json';
const skillMd = (name: string, text: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${text}\n`;

function put(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

test('restore at start: the host waits longer, and a backup brings the workspace skills back', async () => {
  const f = portabilityFixture({ fileDb: true });
  try {
    const voice = path.join(f.paths.workspace, 'skills', 'house-voice', 'SKILL.md');
    put(voice, skillMd('house-voice', 'Short and warm.'));
    const backup = await f.portability.backup();
    rmSync(path.dirname(voice), { recursive: true, force: true });
    await f.portability.restore(backup.path);
    f.db.close(); // the runtime restores before createCore opens the database

    const reasons: string[] = [];
    const host = { extendBoot: async (reason: 'restore') => { reasons.push(reason); } };
    const log = new MemoryLogger();
    assert.equal(await restoreAtStart(f.paths, log, host), true);
    assert.deepEqual(reasons, ['restore']);
    assert.equal(readFileSync(voice, 'utf8'), skillMd('house-voice', 'Short and warm.'), 'the workspace skill is back');
    const applied = log.entries.filter((entry) => entry.message === 'staged restore applied');
    assert.equal(applied.length, 1, 'logged once, by the restore itself');
    assert.equal(typeof applied[0].data?.from, 'string', 'with the backup it came from');

    assert.equal(await restoreAtStart(f.paths, log, host), false, 'applied once only');
    assert.deepEqual(reasons, ['restore'], 'no restore waits: the host is not asked again');
  } finally { f.cleanup(); }
});

test('restore at start never throws: a host that cannot wait longer and a broken marker leave the start going', async () => {
  const f = portabilityFixture();
  try {
    writeFileSync(path.join(f.paths.data, RESTORE_MARKER), '{ not json');
    const log = new MemoryLogger();
    const host = { extendBoot: () => Promise.reject(new Error('host gone')) };
    assert.equal(await restoreAtStart(f.paths, log, host), false);
    assert.ok(!existsSync(path.join(f.paths.data, RESTORE_MARKER)), 'the broken marker is not retried at every start');
    assert.ok(existsSync(path.join(f.paths.data, RESTORE_FAILED)));
    assert.ok(log.entries.some((entry) => entry.level === 'error' && entry.message === 'staged restore not applied'), JSON.stringify(log.entries));
    assert.equal(await restoreAtStart(f.paths, log, {}), false, 'nothing staged, a host without extendBoot');
  } finally { f.cleanup(); }
});

/** Core and Network fakes whose stop methods record their name (async ones settle a tick later). */
function parts(fail: ReadonlySet<string> = new Set()) {
  const calls: string[] = [];
  const sync = (name: string) => () => {
    calls.push(name);
    if (fail.has(name)) throw new Error(`${name} broke`);
  };
  const later = (name: string) => async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    calls.push(name);
    if (fail.has(name)) throw new Error(`${name} broke`);
  };
  const core = {
    services: {
      accounts: { dispose: later('accounts.dispose') }, apps: { stop: later('apps.stop') }, db: { close: sync('db.close') },
      dataLifecycle: { stop: sync('dataLifecycle.stop') }, rootWatcher: { stop: sync('rootWatcher.stop') },
    },
    dispatcher: { stop: later('dispatcher.stop') },
    accountMonitor: { stop: sync('accountMonitor.stop') },
    mcp: { close: sync('mcp.close') },
    scheduler: { stop: sync('scheduler.stop') },
    catalog: { stop: sync('catalog.stop') },
    mesh: { close: sync('mesh.close') },
    engines: { dispose: later('engines.dispose') },
    supervisor: { killAll: later('supervisor.killAll') },
  } as unknown as Core;
  const network = {
    bridges: { stop: sync('bridges.stop') },
    browser: { close: later('browser.close') },
    computer: { dispose: later('computer.dispose') },
    rpc: { close: sync('rpc.close') },
    devices: { stop: sync('devices.stop') },
    peer: { close: later('peer.close') },
    http: { close: later('http.close') },
  } as unknown as Network;
  return { core, network, calls };
}

const ORDER = [
  'dispatcher.stop', 'accountMonitor.stop', 'accounts.dispose', 'apps.stop', 'mcp.close', 'scheduler.stop', 'catalog.stop',
  'bridges.stop', 'browser.close', 'computer.dispose', 'rpc.close', 'devices.stop', 'peer.close', 'http.close',
  'mesh.close', 'engines.dispose', 'supervisor.killAll', 'dataLifecycle.stop', 'rootWatcher.stop', 'db.close',
];

test('stop: every step in order, each awaited; sign-ins after the dispatcher, the database last', async () => {
  const { core, network, calls } = parts();
  const log = new MemoryLogger();
  await runStopSteps(stopSteps(core, network), log);
  assert.deepEqual(calls, ORDER);
  assert.deepEqual(log.entries, []);
});

test('stop: a failing step is logged and the rest still runs, the database closes last', async () => {
  const { core, network, calls } = parts(new Set(['accounts.dispose', 'mcp.close', 'devices.stop']));
  const log = new MemoryLogger();
  await runStopSteps(stopSteps(core, network), log);
  assert.deepEqual(calls, ORDER);
  assert.deepEqual(log.entries.map((entry) => [entry.level, entry.data?.step]), [['warn', 'sign-ins'], ['warn', 'mcp'], ['warn', 'devices']]);
});

test('stop: the device connections right before the peer listener, the data folder watcher right before the database', () => {
  const { core, network } = parts();
  const names = stopSteps(core, network).map((step) => step.name);
  assert.equal(names[names.indexOf('devices') + 1], 'peer', names.join(', '));
  assert.equal(names[names.indexOf('data folder') + 1], 'database', names.join(', '));
  for (const gone of ['playbooks', 'task center', 'vocabulary', 'customize', 'rendezvous', 'remote', 'linked to-dos', 'references', 'knowledge sources', 'knowledge curator', 'knowledge']) {
    assert.ok(!names.includes(gone), `no '${gone}' step`);
  }
});

test('stop: optional parts may be missing (no connectors or devices, services without stop or dispose)', async () => {
  const { core, network, calls } = parts();
  const bare = { ...core, services: { ...core.services, accounts: {}, apps: undefined } } as unknown as Core;
  await runStopSteps(stopSteps(bare, { ...network, devices: undefined } as unknown as Network), new MemoryLogger());
  const missing = ['accounts.dispose', 'apps.stop', 'devices.stop'];
  assert.deepEqual(calls, ORDER.filter((name) => !missing.includes(name)));
});

test('the sign-in step reaches the real account service: AccountServiceImpl has dispose()', () => {
  assert.equal(typeof AccountServiceImpl.prototype.dispose, 'function', 'stopSteps calls accounts.dispose?.(): a rename would skip it silently');
});
