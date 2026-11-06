// Audit 23.10. (runtime systems): a CLI status command that does not answer in time – a cold Claude
// Code start on a loaded 8 GB PC took 5–30 s – leaves the login unknown instead of "signed out"
// (detect.ts), the Claude Code account check reports it as an error (a background check keeps the
// account as it was) instead of needs_login (status.ts), and a scan runs one process per CLI at a time.
// Runtime gaps 23.10.: after a status that timed out the scan skips that CLI's --version, and such a
// report is incomplete (loginUnknown) – the next non-forced detect scans again instead of serving it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, loginUnknown } from '../../../src/runtime/accounts/detect.ts';
import { Adoption } from '../../../src/runtime/accounts/adoption.ts';
import { ClaudeStatus } from '../../../src/runtime/engines/claude/status.ts';
import { fakeFinder, fakeSpawn, testSupervisor, account, type FakeChild } from '../engines/fakes.ts';

const offline = async (): Promise<Response> => { throw new Error('offline'); };

const ANSWERS: Record<string, string> = {
  '/bin/codex --version': 'codex-cli 0.163.0\n',
  '/bin/codex login status': 'Logged in using ChatGPT\n',
  '/bin/claude --version': '2.1.303 (Claude Code)\n',
};

/** Claude's `auth status` never answers; everything else answers on the next tick. Tracks live children per CLI. */
function slowClaude() {
  const live = new Map<string, Set<FakeChild>>();
  let overlap = false;
  const { spawn, calls } = fakeSpawn((call) => {
    const set = live.get(call.command) ?? new Set();
    live.set(call.command, set);
    if (set.size) overlap = true;
    set.add(call.child);
    call.child.once('exit', () => set.delete(call.child));
    const kill = call.child.kill.bind(call.child);
    call.child.kill = () => { set.delete(call.child); return kill(); }; // a process being ended no longer counts
    const line = [call.command, ...call.args].join(' ');
    if (line === '/bin/claude auth status --json') return; // hangs (ended only after its grace, login guard 03.11.)
    const out = ANSWERS[line];
    setImmediate(() => { if (out !== undefined) call.child.stdout.write(out); setImmediate(() => call.child.exit(out === undefined ? 1 : 0)); });
  });
  return { spawn, calls, overlap: () => overlap };
}

test('detect: a status command that times out leaves the login unknown (no --version after it); one process per CLI at a time', async () => {
  const fake = slowClaude();
  const report = await detect({
    finder: fakeFinder({ codex: '/bin/codex', claude: '/bin/claude' }), supervisor: testSupervisor(fake.spawn),
    env: {}, fetch: offline, probeTimeoutMs: 1, cliTimeoutMs: 30,
  });
  const claude = report.clis.find((cli) => cli.provider === 'claude')!;
  assert.deepEqual(claude, { provider: 'claude', path: '/bin/claude' }, 'installed, login unknown (no loggedIn: false)');
  assert.deepEqual(report.clis.find((cli) => cli.provider === 'codex'), { provider: 'codex', path: '/bin/codex', version: '0.163.0', loggedIn: true, method: 'chatgpt' });
  assert.equal(fake.overlap(), false, 'status and version of one CLI never run at the same time');
  const order = (command: string) => fake.calls.filter((call) => call.command === command).map((call) => call.args[0]);
  assert.deepEqual(order('/bin/claude'), ['auth'], 'a status that timed out: no second cold start for the version');
  assert.deepEqual(order('/bin/codex'), ['login', '--version'], 'an answered status: then the version');
  assert.equal(loginUnknown(report), true, 'the report is incomplete');
  const auth = fake.calls.find((call) => call.command === '/bin/claude')!;
  assert.equal(auth.child.killed, false, 'login guard 03.11.: the default home\'s auth status is not killed at the timeout, only after its grace');
});

test('loginUnknown: only an installed Codex or Claude Code without a login answer (ACP plan CLIs and missing CLIs do not count)', () => {
  assert.equal(loginUnknown({ clis: [{ provider: 'codex', path: '/bin/codex' }] }), true);
  assert.equal(loginUnknown({ clis: [{ provider: 'codex', path: '/bin/codex', loggedIn: false }, { provider: 'claude', path: '/bin/claude', loggedIn: true }] }), false);
  assert.equal(loginUnknown({ clis: [{ provider: 'claude' }, { provider: 'gemini-cli', path: '/bin/gemini' }, { provider: 'copilot', path: '/bin/copilot' }, { provider: 'kimi-cli', path: '/bin/kimi' }] }), false);
});

test('adoption: a report with an unknown login is scanned again on the next non-forced detect (no timer), a complete one is served from the cache', async () => {
  const reports = [
    { clis: [{ provider: 'claude' as const, path: '/bin/claude' }], localServers: [], envKeys: [], checkedAt: 1 },
    { clis: [{ provider: 'claude' as const, path: '/bin/claude', version: '2.1.303', loggedIn: true, method: 'claude.ai' }], localServers: [], envKeys: [], checkedAt: 2 },
  ];
  let scans = 0;
  const saved: unknown[] = [];
  const adoption = new Adoption({
    repo: { list: () => [] } as never, dismissed: { list: () => [], mark: (report: unknown) => report } as never,
    save: (row) => { saved.push(row); return row; }, blank: (provider, patch) => ({ ...account({ provider }), ...patch }),
    checkOnce: () => {}, scan: async () => reports[Math.min(scans++, reports.length - 1)], env: () => ({}), now: () => 1,
  });
  assert.equal((await adoption.detect(false)).checkedAt, 1);
  assert.equal(saved.length, 0, 'an unknown login is not adopted');
  assert.equal((await adoption.detect(false)).checkedAt, 2, 'the incomplete report is not served again: a new scan');
  assert.equal(scans, 2);
  assert.equal(saved.length, 1, 'the login the second scan found is adopted');
  assert.equal((await adoption.detect(false)).checkedAt, 2, 'a complete report comes from the cache');
  assert.equal(scans, 2, 'no further scan');
  assert.equal(adoption.cached()?.checkedAt, 2);
});

test('adoption: an unknown login neither adopts a new account nor flips a signed-in one to needs_login', () => {
  const checks: string[] = [];
  const saved: unknown[] = [];
  const own = account({ id: 'acc_claude', provider: 'claude', state: 'ok' });
  const adoption = new Adoption({
    repo: { list: () => [own] } as never, dismissed: { list: () => [], mark: (report: unknown) => report } as never,
    save: (row) => { saved.push(row); return row; }, blank: (provider, patch) => ({ ...account({ provider }), ...patch }),
    checkOnce: (id) => checks.push(id), scan: async () => { throw new Error('unused'); }, env: () => ({}), now: () => 1,
  });
  adoption.adopt({ clis: [{ provider: 'claude', path: '/bin/claude' }, { provider: 'codex', path: '/bin/codex' }], localServers: [], envKeys: [], checkedAt: 1 });
  assert.deepEqual(checks, [], 'no check queued: nothing is known to have changed');
  assert.deepEqual(saved, [], 'an unknown login is not adopted');
  adoption.adopt({ clis: [{ provider: 'claude', path: '/bin/claude', loggedIn: false }], localServers: [], envKeys: [], checkedAt: 2 });
  assert.deepEqual(checks, ['acc_claude'], 'a real "not signed in" answer is still checked');
});

test('claude status: an auth status that does not answer is an error (unknown), never needs_login; it is ended only after its grace', async () => {
  const { spawn, calls } = fakeSpawn(() => { /* never answers */ });
  const status = new ClaudeStatus({ supervisor: testSupervisor(spawn), tempDir: '/tmp/wf', timeoutMs: 30, graceMs: 60 });
  const check = await status.check({ command: '/bin/claude', prefixArgs: [], path: '/bin/claude' }, account({ provider: 'claude', home: '/homes/claude/a' }));
  assert.deepEqual(check, { state: 'error', message: 'Claude Code did not answer the account check.' });
  assert.equal(calls.length, 1, 'no probe after a status without an answer');
  assert.equal(calls[0].child.killed, false, 'not killed at the timeout: it may be refreshing the sign-in (login guard 03.11.)');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(calls[0].child.killed || calls[0].child.exitCode !== null, 'the hanging process is ended after its grace');
});
