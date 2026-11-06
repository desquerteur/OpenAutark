// AccountService isolation (security carry-over, engine isolation 21.10.): every CLI the service
// starts – the scan's `--version` and status commands and the sign-ins – runs in the empty engine
// folder (system/paths.ts engineCwd), never the process cwd where a project config could apply;
// Kimi Code's `kimi login` window (B-044) gets the account's own KIMI_CODE_HOME. A check that ends
// during shutdown (its process was stopped) stores nothing.
// Owns: nothing in production. Never starts a real CLI or touches the disk or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { AccountServiceImpl } from '../../../src/runtime/accounts/service.ts';
import { engineCwd } from '../../../src/runtime/system/paths.ts';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { Bus } from '../../../src/runtime/bus.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import type { AccountCheck, Engine } from '../../../src/runtime/engines/types.ts';
import type { EngineId } from '../../../src/shared/model/providers.ts';
import { fakeFinder, fakeSpawn, testSupervisor, tick } from '../engines/fakes.ts';

const DATA = path.resolve('fake-data');
const PATHS = { accounts: path.join(DATA, 'accounts'), data: DATA, temp: path.join(DATA, 'tmp') };

function setup(check: (id: EngineId) => Promise<AccountCheck> = async () => ({ state: 'ok' })) {
  const db = new Db(':memory:');
  migrate(db);
  // Status commands answer at once; sign-in processes stay open.
  const { spawn, calls } = fakeSpawn((call) => { if (!call.args.includes('login') || call.args.includes('status')) setImmediate(() => call.child.exit(0)); });
  const engine = (id: EngineId): Engine => ({
    id, caps: { sessions: false, dynamicTools: false, mcp: false, images: false, rebase: false, structured: false, ownTools: false },
    listModels: async () => [], checkAccount: () => check(id), run: async () => { throw new Error('not used'); }, dispose: async () => {},
  });
  const service = new AccountServiceImpl({
    db, bus: new Bus((error) => { throw error; }), clock: new ManualClock(), paths: PATHS, env: { PATH: '/usr/bin' },
    finder: fakeFinder({ codex: '/bin/codex', claude: '/bin/claude', kimi: '/bin/kimi' }), supervisor: testSupervisor(spawn), terminal: { platform: 'win32' },
    secrets: { save: async () => ({ id: 'none' }), read: async () => undefined, remove: () => {} },
    engines: () => ({ get: engine, all: () => [], disposeIdle: async () => {} }), mkdir: async () => {}, signInUrlMs: 0,
    detectDeps: { fetch: async () => { throw new Error('offline'); }, probeTimeoutMs: 1 },
  });
  return { service, calls };
}

test('service cwd: the scan and the sign-ins start in the empty engine folder; a Kimi Code account signs in in its own home', async () => {
  const { service, calls } = setup();
  await service.detect();
  await service.add({ provider: 'codex' }); // its own home, then its sign-in
  const kimi = await service.add({ provider: 'kimi-cli' }); // B-044: its own home like Codex, `kimi login` in a terminal window
  const commands = calls.map((call) => `${path.basename(call.command)} ${call.args.join(' ')}`);
  for (const expected of ['codex --version', 'codex login status', 'claude auth status --json', 'kimi --help', 'codex login']) {
    assert.ok(commands.includes(expected), `${expected} ran`);
  }
  for (const call of calls) assert.equal(call.options.cwd, engineCwd(PATHS), `${call.args.join(' ')}: never the process cwd`);
  assert.equal(kimi.home, path.join(PATHS.accounts, 'kimi-cli', kimi.id));
  const window = calls.find((call) => call.options.env?.WORKFORCE_TERMINAL_EXE === '/bin/kimi');
  assert.ok(window && /powershell\.exe$/i.test(window.command), 'the visible terminal launcher');
  assert.equal(window.options.env?.WORKFORCE_TERMINAL_ARGS, JSON.stringify(['login']));
  assert.equal(window.options.env?.KIMI_CODE_HOME, kimi.home, 'the account home, never the default ~/.kimi-code');
  await service.dispose();
});

test('service dispose: a check still running at shutdown stores nothing', async () => {
  let answer: (check: AccountCheck) => void = () => {};
  const { service } = setup((id) => (id === 'compatible' ? new Promise((resolve) => { answer = resolve; }) : Promise.resolve({ state: 'ok' })));
  const account = await service.add({ provider: 'compatible', baseUrl: 'http://127.0.0.1:9/v1', label: 'Local' });
  await tick();
  const before = service.get(account.id);
  await service.dispose();
  answer({ state: 'error', message: 'The process was stopped.' }); // killed in the shutdown's process step
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(service.get(account.id), before);
});
