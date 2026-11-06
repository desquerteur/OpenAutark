// What the composition root (runtime/compose/services.ts, network.ts) wires, checked in its source because
// building it needs every service: PR8 – the account service reports the client version to ACP sign-in probes
// and the engine registry starts an ACP plan with the launch the account service resolved
// (test/unit/engines/acp-providers.test.ts runs that pair); the file watchers of the open data folder (theme.css
// right after settings.json, the connectors) and the browser live view; the decision hub has one backend – a
// connected model – and answers "no answer" without one (behaviour, over fake services). And runtime/main.ts
// passes every host power event to afterPower: resume/unlock restart the scheduler timer, the PC links, the peer
// listener and the plan readings; B-044 'online' the PC links and the plan readings.
// Owns: these assertions only. Never: network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDecisionHub } from '../../../src/runtime/compose/decisions.ts';
import { afterPower } from '../../../src/runtime/main.ts';

const source = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
const SERVICES = source('src/runtime/compose/services.ts');
const NETWORK = source('src/runtime/compose/network.ts');
const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

test('PR8: the account service gets the version, the engine registry the ACP launch resolver', () => {
  const accounts = SERVICES.match(/new AccountServiceImpl\(\{([\s\S]*?)\n {2}\}\);/)?.[1] ?? '';
  assert.match(accounts, /\bversion: options\.version\b/);
  const registry = SERVICES.match(/createEngineRegistry\(\{([\s\S]*?)\n {2}\}\);/)?.[1] ?? '';
  assert.match(registry, /\bacp: accounts\.acpLaunch\b/);
});

test('the data folder files: theme.css is watched right after settings.json, the connectors start once the registry exists', () => {
  const settings = SERVICES.indexOf('new SettingsStore(');
  const theme = SERVICES.indexOf('watchTheme({ dataDir: paths.data, root: s.rootWatcher, bus, log });');
  assert.ok(settings > 0 && theme > settings, 'watchTheme after the settings store');
  const registry = SERVICES.indexOf('registerBuiltinTools(tools);');
  const apps = SERVICES.indexOf('createApps(s, { supervisor, version: options.version })');
  assert.ok(registry > 0 && apps > registry, 'the connectors after the tool registry');
  assert.match(SERVICES, /\n {2}apps\.start\(\);/);
});

test('the browser live view and the devices are wired in network.ts', () => {
  const browser = NETWORK.indexOf('new BrowserService(');
  const view = NETWORK.indexOf('startBrowserView(services, browser);');
  const devices = NETWORK.indexOf('createDevices({');
  assert.ok(browser > 0 && view > browser && devices > view, 'the live view right after the browser, the devices after both');
  assert.match(NETWORK, /\bremote: devices\.remote\b/);
  assert.match(NETWORK, /relay: \{ state: \(\) => devices\.meeting\.state\(\) \}/);
});

test('the decision hub: no connected model – no answer; a connected model – available', async () => {
  const models: Array<{ id: string; available: boolean }> = [];
  const services = {
    catalog: { list: () => models, get: () => undefined },
    secrets: { redact: (text: string) => text },
    clock: { now: () => 1 },
    log: SILENT,
  };
  const hub = createDecisionHub(() => services as never);
  assert.equal(hub.available(), false);
  const answer = await hub.decide({ question: 'Which?', type: 'choice', options: ['a', 'b'], purpose: 'other' });
  assert.equal(answer.confidence, 0);
  models.push({ id: 'm1', available: true });
  assert.equal(hub.available(), true, 'reads the catalog on every call – no restart');
});

test('host power events: resume/unlock restart the timer, links, listener and readings; online the links and readings', () => {
  assert.match(source('src/runtime/main.ts'), /options\.host\.onPower\(\(event\) => afterPower\(event, \{/);
  const calls: string[] = [];
  const parts = {
    scheduler: { arm: () => { calls.push('arm'); } }, mesh: { reconnect: () => { calls.push('reconnect'); } },
    monitor: { resume: () => { calls.push('resume'); } }, refreshPeer: () => { calls.push('peer'); },
  };
  const after = (event: Parameters<typeof afterPower>[0]) => { calls.length = 0; afterPower(event, parts); return [...calls]; };
  assert.deepEqual(after('resume'), ['arm', 'reconnect', 'peer', 'resume']);
  assert.deepEqual(after('unlock'), ['arm', 'reconnect', 'peer', 'resume']);
  assert.deepEqual(after('online'), ['reconnect', 'resume']);
  assert.deepEqual(after('suspend'), []);
  assert.deepEqual(after('lock'), []);
});
