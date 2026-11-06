// B-051 L3: adding a Codex or Claude Code plan installs its missing CLI first – a failed install throws
// its error and creates nothing (no orphan account, no home, no retry row). L5: a Claude Free sign-in is
// not "Signed in": the status check answers 'error' with "Claude Code needs a Claude Pro or Max plan."
// (no probe for it), and the account service stores that even from a background check, while other
// failed background checks still change nothing.
// Owns: nothing in production. Never runs a real installer or CLI (account harness, scripted children).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { INSTALL_FAILED } from '../../../src/runtime/accounts/install.ts';
import { CLAUDE_FREE_PLAN, claudeFreePlan, planBlocked } from '../../../src/runtime/accounts/cli.ts';
import { ClaudeStatus } from '../../../src/runtime/engines/claude/status.ts';
import { account, fakeSpawn, testSupervisor } from '../engines/fakes.ts';
import { ACCOUNTS, harness, row } from './harness.ts';

const commands = (h: ReturnType<typeof harness>) => h.calls.map((call) => call.args.join(' '));

test('L3: a missing Codex is installed before its account and sign-in; a fresh install rescans in the background', async () => {
  const h = harness({ clis: { codex: null }, install: (call) => { h.clis.codex = '/bin/codex'; setImmediate(() => call.child.exit(0)); } });
  const added = await h.service.add({ provider: 'codex' });
  const order = commands(h);
  const install = order.findIndex((line) => line.includes('install.ps1') || line.includes('install.sh'));
  assert.ok(install >= 0, 'the official installer ran');
  assert.ok(install < order.indexOf('login'), 'before the sign-in');
  assert.deepEqual([added.state, added.home, h.made], ['needs_login', path.join(ACCOUNTS, 'codex', added.id), [path.join(ACCOUNTS, 'codex', added.id)]]);
  await h.settle();
  assert.ok(commands(h).includes('login status'), 'the detection report learns the CLI is there');
  await h.service.dispose();
});

test('L3: a failed install throws its error and creates nothing – adding again does not find an orphan', async () => {
  const h = harness({ clis: { claude: null, codex: null } }); // installers exit 0 but install nothing
  await assert.rejects(h.service.add({ provider: 'codex' }), (error: Error) => error.message === INSTALL_FAILED.codex);
  await assert.rejects(h.service.add({ provider: 'claude', label: 'Personal' }), (error: Error) => error.message === INSTALL_FAILED.claude);
  await assert.rejects(h.service.add({ provider: 'claude' }), (error: Error) => error.message === INSTALL_FAILED.claude);
  assert.deepEqual([h.service.list().length, h.made.length, h.signIns.length], [0, 0, 0], 'no account, no home, no sign-in');
  assert.ok(!h.upserts.length, 'no account event');
  // Installed now: one account, the first one.
  h.clis.claude = '/bin/claude';
  const added = await h.service.add({ provider: 'claude' });
  assert.deepEqual([h.service.list().length, added.label], [1, 'Claude Code']);
  await h.service.dispose();
});

test('L3: an installed CLI is never installed again; API and local accounts never install anything', async () => {
  const h = harness();
  await h.service.add({ provider: 'codex' });
  await h.service.add({ provider: 'openai', apiKey: 'sk-test-0123456789' });
  assert.ok(!commands(h).some((line) => /install/.test(line)), 'no installer ran');
  await h.service.dispose();
});

test('L5: claudeFreePlan – a claude.ai login on Free (any case); unknown plans and API logins pass', () => {
  assert.ok(claudeFreePlan({ method: 'claude', plan: 'free' }));
  assert.ok(claudeFreePlan({ method: 'claude', plan: ' Free ' }));
  for (const status of [{ method: 'claude', plan: 'pro' }, { method: 'claude', plan: 'max' }, { method: 'claude', plan: 'team' }, { method: 'claude' }, { method: 'api', plan: 'free' }]) assert.ok(!claudeFreePlan(status), JSON.stringify(status));
  assert.ok(planBlocked({ state: 'error', message: CLAUDE_FREE_PLAN }));
  assert.ok(!planBlocked({ state: 'error', message: 'Claude Code did not answer the account check.' }));
  assert.equal(CLAUDE_FREE_PLAN, 'Claude Code needs a Claude Pro or Max plan.');
});

/** ClaudeStatus over a scripted `auth status --json`; the probe never answers (short timeout). */
function status(answer: Record<string, unknown>) {
  const { spawn, calls } = fakeSpawn((call) => {
    if (call.args.join(' ') !== 'auth status --json') return; // the probe stays silent until its timeout
    setImmediate(() => { call.child.stdout.write(JSON.stringify(answer)); setImmediate(() => call.child.exit(0)); });
  });
  return { status: new ClaudeStatus({ supervisor: testSupervisor(spawn), tempDir: '/tmp/wf', timeoutMs: 40 }), calls };
}
const EXE = { command: '/bin/claude', prefixArgs: [], path: '/bin/claude' };

test('L5: a Claude Free sign-in is an error with the plan message (no probe); Pro and API logins stay ok', async () => {
  const free = status({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'free', email: 'p@example.com' });
  const check = await free.status.check(EXE, account({ id: 'acc_free', provider: 'claude', home: '/data/accounts/claude/acc_free' }));
  assert.deepEqual(check, { state: 'error', message: CLAUDE_FREE_PLAN, plan: 'free', email: 'p@example.com' });
  assert.equal(free.calls.length, 1, 'no probe process for a plan that cannot run agents');

  const pro = status({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro' });
  assert.equal((await pro.status.check(EXE, account({ id: 'acc_pro', provider: 'claude' }))).state, 'ok');
  const api = status({ loggedIn: true, authMethod: 'console', subscriptionType: 'free' });
  assert.equal((await api.status.check(EXE, account({ id: 'acc_api', provider: 'claude' }))).state, 'ok', 'Codex-like rule: an API login is not blocked by plan');
});

test('L5: the service stores the plan block even from a background check; other failed background checks change nothing', async () => {
  const h = harness();
  h.repo.save(row('acc_free', { provider: 'claude', auth: 'cli', state: 'ok', detected: true }));
  h.repo.save(row('acc_slow', { provider: 'claude', auth: 'cli', state: 'ok', detected: true }));
  h.answers.set('acc_free', { state: 'error', message: CLAUDE_FREE_PLAN, plan: 'free' });
  h.answers.set('acc_slow', { state: 'error', message: 'Claude Code did not answer the account check.' });
  const free = await h.service.check('acc_free', true);
  assert.deepEqual([free.state, free.plan], ['error', 'free'], 'adopted Free logins are never shown as signed in');
  assert.equal((await h.service.check('acc_slow', true)).state, 'ok', 'a check that failed keeps the account as it was');
  h.answers.set('acc_free', { state: 'ok', plan: 'pro' }); // upgraded
  assert.equal((await h.service.check('acc_free', true)).state, 'ok');
  await h.service.dispose();
});
