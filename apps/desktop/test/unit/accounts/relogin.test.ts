// B-047 D10: a provider sign-out becomes work. accounts/failure.ts reports a plan found signed out once
// (to the relogin service when wired, else the old notification); accounts/relogin.ts gives ONE task "Sign in to
// <account> again" to the origin Manager while another account is usable, a real human to-do (credential) with a
// notification naming it when none is, no agent can take it or the day's cap is reached; the work closes itself
// once the account is usable again and is cancelled when it is removed. accounts.sign_in starts the official
// CLI sign-in through AccountService.login and never returns tokens or e-mails.
// Owns: these assertions only. Never: a real CLI or the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from '../chat/harness.ts';
import { recordAccountFailure } from '../../../src/runtime/accounts/failure.ts';
import { MAX_PER_DAY, Relogin, signInAgent } from '../../../src/runtime/accounts/relogin.ts';
import { accountTools, pickAccount } from '../../../src/runtime/tools/builtin/accounts.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { Account } from '../../../src/shared/model/providers.ts';
import type { EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';

function account(id: string, extra: Partial<Account> = {}): Account {
  return { id, provider: 'codex', label: 'Codex work', auth: 'cli', state: 'ok', priority: 0, rotation: true, enabled: true, detected: true, createdAt: 0, ...extra };
}

const SIGNED_OUT = { stop: 'error', text: '', error: { code: 'unavailable', message: 'Codex is not signed in.' } } as unknown as EngineTurnResult;

/** The chat harness plus an account store whose markUnavailable emits account.upserted like the real one. */
function rig(accounts: Account[], options: { manager?: boolean } = {}) {
  const h = harness();
  const store = new Map(accounts.map((item) => [item.id, item]));
  const logins: string[] = [];
  const service = {
    list: () => [...store.values()],
    get: (id: string) => store.get(id),
    markLimited: () => {},
    markUnavailable: (id: string, state: 'needs_login' | 'error') => {
      const current = store.get(id);
      if (!current || current.state === state) return false;
      const next = { ...current, state };
      store.set(id, next);
      h.bus.emit('account.upserted', next);
      return true;
    },
    login: async (id: string) => { logins.push(id); return { started: true }; },
  };
  const warnings: unknown[][] = [];
  Object.assign(h.services, { accounts: service, log: { debug() {}, info() {}, error() {}, warn: (...args: unknown[]) => { warnings.push(args); } } });
  if (options.manager !== false) h.org.add(agent('ag_boss', 'Mia', { mode: 'manager' }));
  h.org.add(agent('ag_dev', 'Dev', { managerId: options.manager !== false ? 'ag_boss' : undefined }));
  const relogin = new Relogin({ services: () => h.services });
  const unwatch = relogin.watch();
  const set = (id: string, patch: Partial<Account>) => { const next = { ...store.get(id)!, ...patch }; store.set(id, next); h.bus.emit('account.upserted', next); };
  const fail = (id: string, withRelogin = true) => recordAccountFailure({ accounts: service, clock: h.clock, notifications: h.services.notifications, ...(withRelogin ? { relogin } : {}) }, store.get(id)!, 'gpt-6.1-sol', SIGNED_OUT);
  return { ...h, store, service, relogin, set, fail, logins, warnings, unwatch };
}

test('failure.ts: a sign-out goes to the relogin service once; without it the old notification', () => {
  const r = rig([account('acc_a'), account('acc_b', { provider: 'claude', label: 'Claude Max' })]);
  assert.equal(r.fail('acc_a'), 'signed_out');
  assert.equal(r.store.get('acc_a')!.state, 'needs_login');
  assert.equal(r.tasks.list({}).filter((task) => task.title === 'Sign in to Codex work again').length, 1);
  assert.equal(r.notified.length, 0, 'work, not a notification');
  assert.equal(r.fail('acc_a'), 'signed_out', 'the same sign-out again changes nothing');
  assert.equal(r.tasks.list({}).filter((task) => task.title.startsWith('Sign in')).length, 1);

  const old = rig([account('acc_a')]);
  old.unwatch(); // no relogin service in this runtime
  old.fail('acc_a', false);
  assert.equal(old.notified.length, 1);
  assert.equal(old.notified[0].title, 'Sign in to Codex work');
});

test('a helper call that finds the sign-out first (deps without relogin, decision/engine-runner.ts) creates the same work', () => {
  const r = rig([account('acc_a'), account('acc_b', { provider: 'claude', label: 'Claude Max' })]);
  assert.equal(r.fail('acc_a', false), 'signed_out'); // the runner's deps: accounts, clock, notifications – no relogin
  const tasks = r.tasks.list({}).filter((task) => task.title === 'Sign in to Codex work again');
  assert.equal(tasks.length, 1, 'the account service carries the runtime\'s relogin service');
  assert.equal(tasks[0].assigneeId, 'ag_boss');
  assert.equal(r.notified.length, 0, 'work, not a notification-only message');
  const other = rig([account('acc_a')]);
  other.unwatch();
  other.fail('acc_a', false);
  assert.equal(other.tasks.list({}).filter((task) => task.title.startsWith('Sign in')).length, 0, 'another runtime\'s service is never used');
});

test('another usable account: ONE task for the origin Manager with the way through; it closes itself when the account works again', () => {
  const r = rig([account('acc_a', { email: 'alex@example.com', label: 'Codex · alex@example.com' }), account('acc_b', { provider: 'claude', label: 'Claude Max' })]);
  r.fail('acc_a');
  const [task] = r.tasks.list({}).filter((item) => item.title.startsWith('Sign in'));
  assert.equal(task.assigneeKind, 'agent');
  assert.equal(task.assigneeId, 'ag_boss');
  assert.match(task.notes, /accounts\.sign_in with accountId "acc_a" starts the official Codex sign-in/);
  assert.match(task.notes, /I type no password myself/);
  assert.match(task.notes, /closes itself/);
  assert.ok(!task.title.includes('alex@example.com') && !task.notes.includes('alex@example.com'), 'no e-mail');
  assert.equal(r.relogin.openWork('acc_a')?.id, task.id);

  r.set('acc_a', { state: 'ok' });
  const closed = r.tasks.get(task.id)!;
  assert.equal(closed.status, 'done');
  assert.match(closed.result!.summary, /works again/);
  assert.equal(r.relogin.openWork('acc_a'), undefined);
});

test('no usable account left: a real human to-do (credential) and one notification that names it; it closes itself too', () => {
  const r = rig([account('acc_a')]);
  r.fail('acc_a');
  const [todo] = r.tasks.list({}).filter((item) => item.title.startsWith('Sign in'));
  assert.equal(todo.assigneeKind, 'human');
  assert.equal(todo.humanReason, 'credential');
  assert.match(todo.notes, /No other model account can run the team right now/);
  assert.match(todo.notes, /Settings › Models/);
  assert.equal(r.notified.length, 1);
  assert.equal(r.notified[0].taskId, todo.id, 'the notification names the to-do');
  r.set('acc_a', { state: 'ok' });
  assert.equal(r.tasks.get(todo.id)!.status, 'done');
});

test('no agent to take it, or the day\'s cap of sign-in tasks reached: the person gets the to-do', () => {
  const lonely = rig([account('acc_a'), account('acc_b', { provider: 'claude' })], { manager: false });
  assert.equal(signInAgent(lonely.services), undefined);
  lonely.fail('acc_a');
  assert.equal(lonely.tasks.list({}).find((item) => item.title.startsWith('Sign in'))!.assigneeKind, 'human');

  const r = rig([account('acc_a'), account('acc_b', { provider: 'claude' })]);
  for (let round = 0; round < MAX_PER_DAY; round++) {
    r.fail('acc_a');
    r.set('acc_a', { state: 'ok' }); // signed in again – the task closes
  }
  r.fail('acc_a');
  const last = r.tasks.list({}).filter((item) => item.title.startsWith('Sign in')).find((item) => item.status !== 'done')!;
  assert.equal(last.assigneeKind, 'human', 'a sign-in that keeps failing goes to the person');
  assert.match(last.notes, new RegExp(`tried to sign it in again ${MAX_PER_DAY} times today`));
  r.clock.advance(25 * 3600_000);
  r.set('acc_a', { state: 'ok' });
  r.fail('acc_a');
  assert.equal(r.relogin.openWork('acc_a')!.assigneeKind, 'agent', 'a new day: the Manager again');
});

test('no Manager: the computer-mode agent gets the sign-in task and is offered accounts.sign_in', () => {
  const r = rig([account('acc_a'), account('acc_b', { provider: 'claude' })], { manager: false });
  const operator = agent('ag_pc', 'Pat', { mode: 'computer' });
  r.org.add(operator);
  assert.equal(signInAgent(r.services)?.id, 'ag_pc');
  r.fail('acc_a');
  assert.equal(r.relogin.openWork('acc_a')?.assigneeId, 'ag_pc');
  // The task names accounts.sign_in, so the computer mode must offer it (review fix: it did not).
  const registry = new Registry({ services: () => r.services });
  for (const tool of accountTools) registry.register(tool);
  registry.register({ name: 'computer.act', description: 'operate the screen', inputSchema: { type: 'object' }, category: 'device', requires: 'device', describe: () => ({ summary: 'act', resource: 'screen', reversible: true, external: false }), run: async () => ({ content: [] }) });
  const computer: ModeInfo = { key: 'computer', name: 'Computer', description: '', skills: [], tools: ['computer.*', 'shell.*'], category: 'computer-use', workspace: 'computer', instructions: '' };
  const research: ModeInfo = { key: 'research', name: 'Research', description: '', skills: [], tools: ['web.*', 'files.*'], category: 'research', instructions: '' };
  assert.ok(registry.specsFor(operator, computer).some((spec) => spec.name === 'accounts.sign_in'));
  assert.ok(registry.specsFor(operator, research).some((spec) => spec.name === 'accounts.sign_in'), 'every mode starts a sign-in (registry EVERY_MODE)');
});

test('the account removed or switched off: its open sign-in work is cancelled', () => {
  const r = rig([account('acc_a'), account('acc_b', { provider: 'claude' })]);
  r.fail('acc_a');
  const task = r.relogin.openWork('acc_a')!;
  r.bus.emit('account.removed', { id: 'acc_a' });
  assert.equal(r.tasks.get(task.id)!.status, 'cancelled');
  r.set('acc_a', { state: 'ok' });
  r.fail('acc_a');
  const again = r.relogin.openWork('acc_a')!;
  r.set('acc_a', { enabled: false });
  assert.equal(r.tasks.get(again.id)!.status, 'cancelled');
  assert.deepEqual(r.warnings, [], 'nothing failed on the way');
});

test('accounts.sign_in: the named or only signed-out account, the official sign-in started, nothing private returned', async () => {
  const r = rig([account('acc_a', { state: 'needs_login', email: 'alex@example.com', label: 'Codex · alex@example.com', home: '/home/alex/.codex' }), account('acc_b', { provider: 'claude', label: 'Claude Max' })]);
  const tool = accountTools.find((item) => item.name === 'accounts.sign_in')!;
  assert.equal(tool.category, 'account');
  const ctx = { agent: r.org.get('ag_boss')!, runId: 'run_1', mode: 'manager', services: r.services, signal: new AbortController().signal, status: () => {} } as ToolContext;
  const out = await tool.run({}, ctx);
  const text = out.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
  assert.equal(out.isError, undefined, text);
  assert.deepEqual(r.logins, ['acc_a']);
  assert.match(text, /Started the official codex sign-in for Codex/);
  assert.match(text, /I type no password/);
  assert.ok(!text.includes('alex@example.com') && !text.includes('.codex'));
  assert.equal(tool.describe!({}, ctx).summary, 'Start the sign-in to Codex');
  const already = await tool.run({ accountId: 'acc_b' }, ctx);
  assert.match(already.content[0].type === 'text' ? already.content[0].text : '', /signed in already/);
  assert.equal(r.logins.length, 1);
  assert.equal(pickAccount(r.service.list().map((item) => ({ ...item, state: 'ok' as const }))), 'No account needs a sign-in right now.');
  assert.match(String(pickAccount([account('x', { state: 'needs_login' }), account('y', { state: 'needs_login' })])), /Several accounts need a sign-in/);
  assert.equal(HUMAN_ID, 'human');
});
