// CLI sign-ins (accounts/sign-in.ts) at shutdown: a finished sign-in checks its account, but
// dispose() – the 'sign-ins' stop step, after the account monitor stopped and right before the
// child processes and the database – closes the open ones without starting a check, and a check
// still running then is not followed by reading the account (the database may be closed by then).
// Owns: these assertions only. Never: real CLIs, accounts, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignIns } from '../../../src/runtime/accounts/sign-in.ts';
import { account, fakeFinder, fakeSpawn, testSupervisor, tick } from '../engines/fakes.ts';

/** SignIns with fake CLIs; each account check waits until the test ends it. */
function signIns() {
  const { spawn, calls } = fakeSpawn();
  const checks: string[] = [];
  const reads: string[] = [];
  const pending: Array<() => void> = [];
  const service = new SignIns({
    finder: fakeFinder({ codex: '/bin/codex', claude: '/bin/claude' }), supervisor: testSupervisor(spawn), env: {}, now: () => 0, urlWaitMs: 0,
    label: (provider) => provider,
    check: (id) => { checks.push(id); return new Promise<void>((resolve) => pending.push(resolve)); },
    state: (id) => { reads.push(id); return 'ok'; },
  });
  return { service, calls, checks, reads, pending };
}

test('a finished sign-in checks its account; dispose() closes an open one and starts no check', async () => {
  const h = signIns();
  await h.service.login(account({ id: 'acc_done' }));
  h.calls[0].child.exit(0);
  await tick();
  assert.deepEqual(h.checks, ['acc_done'], 'the sign-in ended: its account is checked');
  h.pending.shift()!();
  await tick();
  assert.deepEqual(h.reads, ['acc_done']);

  await h.service.login(account({ id: 'acc_open', provider: 'claude' }));
  await h.service.dispose();
  await tick();
  assert.equal(h.calls[1].child.killed, true, 'the open sign-in process is closed');
  assert.deepEqual(h.checks, ['acc_done'], 'no account check during shutdown');
  assert.deepEqual(h.reads, ['acc_done']);
});

test('dispose() while a sign-in check runs: the account is not read after it', async () => {
  const h = signIns();
  await h.service.login(account({ id: 'acc_late' }));
  h.calls[0].child.exit(0);
  await tick();
  assert.deepEqual(h.checks, ['acc_late']);
  await h.service.dispose();
  h.pending.shift()!(); // the monitor's stop() ends a waiting check
  await tick();
  assert.deepEqual(h.reads, [], 'shut down meanwhile: the account is not read');
});
