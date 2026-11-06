// The model setup's plan buttons always add a sign-in, even when that provider already has accounts.
// Owns: regressions for new accounts, browser sign-in events, waiting, cancellation and fixed action cells.
// Never: runs a real CLI, starts an answer test or reuses an existing account for the plan button.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { signal } from '@preact/signals';
import type { Account, DetectionReport } from '../../../src/shared/model/providers.ts';
import {
  PLAN_LABELS, SIGN_IN_GAVE_UP, SIGN_IN_TEXT, SIGN_IN_WAIT_MS, cliMissing, startPlanSetup,
  type PlanEnv, type PlanProvider, type PlanRpc, type PlanView,
} from '../../../src/ui/onboarding/plan-setup.ts';

const account = (id: string, provider: string, extra: Partial<Account> = {}): Account =>
  ({ id, provider, label: `${provider} ${id}`, auth: 'cli', enabled: true, state: 'ok', priority: 0, rotation: false, detected: false, createdAt: 1, ...extra }) as Account;
const report = (clis: DetectionReport['clis']): DetectionReport => ({ clis, localServers: [], envKeys: [], checkedAt: 1 });
const missing = (provider: PlanProvider) => report([{ provider }]);
const installed = (provider: PlanProvider) => report([{ provider, path: `C:/bin/${provider}.exe` }]);
const SIGN_IN_URL = 'https://auth.openai.com/oauth/authorize?state=test';
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100 && !check(); i += 1) await flush();
  assert.ok(check(), label);
}

/** A flow over fake runtime calls, a real signal, a fake timer and a fake focus. */
function harness(options: { accounts?: Account[]; report?: DetectionReport | null; rpc?: Partial<PlanRpc> } = {}) {
  const accounts = signal<Account[]>(options.accounts ?? []);
  const calls: Array<[string, unknown]> = [];
  const views: PlanView[] = [];
  const timers: Array<{ ms: number; fire: () => void; cancelled: boolean }> = [];
  const focus = new Set<() => void>();
  const record = <T>(name: string, arg: unknown, answer: () => Promise<T>) => { calls.push([name, arg]); return answer(); };
  const rpc: PlanRpc = {
    install: (provider) => record('install', provider, () => options.rpc?.install?.(provider) ?? Promise.resolve({ ok: true })),
    add: (provider) => record('add', provider, () => options.rpc?.add?.(provider) ?? Promise.resolve({ ...account('acc_new', provider, { state: 'needs_login' }), signInUrl: SIGN_IN_URL })),
    recheck: () => record('recheck', undefined, () => Promise.resolve({})),
  };
  const env: PlanEnv = {
    rpc, accounts, report: () => options.report ?? null,
    timer: (ms, fire) => { const entry = { ms, fire, cancelled: false }; timers.push(entry); return () => { entry.cancelled = true; }; },
    focus: (fire) => { focus.add(fire); return () => { focus.delete(fire); }; },
    show: (view) => views.push(view),
  };
  return { accounts, calls, views, timers, focus, env };
}

test('Codex plan installs a missing CLI, adds a sign-in and finishes on the signed-in event without an answer test', async () => {
  const h = harness({ report: missing('codex') });
  const flow = startPlanSetup('codex', h.env);
  assert.equal(h.views[0].text, 'Installing Codex – this takes about a minute…');
  assert.equal(h.views[0].step, 'install');
  await until(() => h.views.some((view) => view.url), 'the sign-in page came back');
  assert.deepEqual(h.calls, [['install', 'codex'], ['add', 'codex']]);
  const waiting = h.views.at(-1)!;
  assert.deepEqual([waiting.step, waiting.text, waiting.url], ['sign-in', SIGN_IN_TEXT, SIGN_IN_URL]);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, SIGN_IN_WAIT_MS);
  assert.equal(h.focus.size, 1);
  [...h.focus][0]();
  assert.deepEqual(h.calls.at(-1), ['recheck', undefined]);
  h.accounts.value = [account('acc_new', 'codex', { state: 'needs_login' }), account('acc_other', 'openai', { auth: 'api_key' })];
  await flush();
  assert.equal(h.views.at(-1)!.step, 'sign-in', 'unrelated account changes leave the flow waiting');
  h.accounts.value = [account('acc_new', 'codex')];
  assert.deepEqual(await flow.done, { ok: true, accountId: 'acc_new' });
  assert.deepEqual(h.calls, [['install', 'codex'], ['add', 'codex'], ['recheck', undefined]]);
  const done = h.views.at(-1)!;
  assert.deepEqual([done.step, done.text, done.tone, done.url], ['done', 'Codex account signed in', 'ok', undefined]);
  assert.equal(h.timers[0].cancelled, true);
  assert.equal(h.focus.size, 0);
});

test('both plan buttons add a new account in every existing account state, then add another on the next click', async () => {
  const states: Account['state'][] = ['ok', 'needs_login', 'cooling', 'error', 'disabled', 'unknown'];
  for (const provider of ['claude', 'codex'] as const) {
    for (const state of states) {
      const existing = account('acc_existing', provider, { state, enabled: state !== 'disabled', detected: true });
      let additions = 0;
      const h = harness({ report: installed(provider), accounts: [existing],
        rpc: { add: async () => account(`acc_new_${++additions}`, provider, { state: 'needs_login' }) } });
      for (let click = 1; click <= 2; click += 1) {
        const before = h.accounts.peek();
        const flow = startPlanSetup(provider, h.env);
        await until(() => h.timers.length === click, `${provider}/${state}: click ${click} starts a sign-in`);
        assert.deepEqual(h.calls, Array.from({ length: click }, () => ['add', provider]), 'every click adds; existing accounts are never checked or signed in');
        h.accounts.value = [...before, account(`acc_new_${click}`, provider)];
        assert.deepEqual(await flow.done, { ok: true, accountId: `acc_new_${click}` });
        assert.equal(h.views.at(-1)!.text, `${provider === 'codex' ? 'Codex' : 'Claude'} account signed in`);
        assert.equal(h.accounts.peek()[0], existing, 'the existing account stays untouched');
      }
      assert.equal(h.focus.size, 0);
      assert.ok(h.timers.every((timer) => timer.cancelled));
    }
  }
});

test('a sign-in without a printed page keeps the inert link cell', async () => {
  const h = harness({ rpc: { add: async () => account('acc_new', 'codex', { state: 'needs_login' }) } });
  const flow = startPlanSetup('codex', h.env);
  await until(() => h.timers.length === 1, 'waiting');
  assert.equal(h.views.at(-1)!.url, undefined);
  flow.cancel();
  await flow.done;
});

test('a sign-in that cannot start shows the runtime error', async () => {
  const h = harness({ rpc: { add: async () => { throw new Error('Could not start the sign-in.'); } } });
  assert.deepEqual(await startPlanSetup('codex', h.env).done, { ok: false, reason: 'sign-in', message: 'Could not start the sign-in.' });
  assert.equal(h.views.at(-1)!.tone, 'error');
  assert.deepEqual(h.calls, [['add', 'codex']]);
});

test('a sign-in already completed by the add result or an earlier event skips the wait and never tests an answer', async () => {
  for (const eventFirst of [false, true]) {
    const h = harness();
    h.env.rpc.add = async () => {
      if (eventFirst) h.accounts.value = [account('acc_new', 'claude')];
      return account('acc_new', 'claude', { state: eventFirst ? 'needs_login' : 'ok' });
    };
    assert.deepEqual(await startPlanSetup('claude', h.env).done, { ok: true, accountId: 'acc_new' });
    assert.equal(h.timers.length, 0);
    assert.equal(h.views.at(-1)!.text, 'Claude account signed in');
  }
});

test('Claude Free is a completed sign-in even though the account cannot run agents', async () => {
  const h = harness();
  const flow = startPlanSetup('claude', h.env);
  await until(() => h.timers.length === 1, 'waiting');
  h.accounts.value = [account('acc_new', 'claude', { state: 'error', plan: 'free' })];
  assert.deepEqual(await flow.done, { ok: true, accountId: 'acc_new' });
  assert.equal(h.views.at(-1)!.text, 'Claude account signed in');
  assert.deepEqual(h.calls, [['add', 'claude']]);
});

test('a passing status-check error keeps waiting for the sign-in event', async () => {
  const h = harness();
  const flow = startPlanSetup('codex', h.env);
  await until(() => h.timers.length === 1, 'waiting');
  h.accounts.value = [account('acc_new', 'codex', { state: 'error' })];
  await flush();
  assert.equal(h.views.at(-1)!.step, 'sign-in');
  assert.equal(h.timers[0].cancelled, false);
  h.accounts.value = [account('acc_new', 'codex', { state: 'cooling' })];
  assert.deepEqual(await flow.done, { ok: true, accountId: 'acc_new' });
  assert.deepEqual(h.calls, [['add', 'codex']]);
});

test('sign-in timeout shows the retry message and cleans up listeners', async () => {
  const h = harness();
  const flow = startPlanSetup('codex', h.env);
  await until(() => h.timers.length === 1, 'waiting');
  h.timers[0].fire();
  assert.deepEqual(await flow.done, { ok: false, reason: 'sign-in', message: SIGN_IN_GAVE_UP });
  assert.deepEqual([h.views.at(-1)!.text, h.views.at(-1)!.tone, h.views.at(-1)!.url], [SIGN_IN_GAVE_UP, 'error', undefined]);
  assert.equal(h.focus.size, 0);
  const shown = h.views.length;
  h.accounts.value = [account('acc_new', 'codex')];
  await flush();
  assert.equal(h.views.length, shown, 'a late sign-in starts nothing');
  assert.deepEqual(h.calls, [['add', 'codex']]);
});

test('install failure shows its error and adds nothing; Claude uses its own installer name', async () => {
  const h = harness({ report: missing('codex'), rpc: { install: async () => { throw new Error('Could not install Codex. Check your connection and try again.'); } } });
  assert.deepEqual(await startPlanSetup('codex', h.env).done, { ok: false, reason: 'install', message: 'Could not install Codex. Check your connection and try again.' });
  assert.deepEqual(h.calls, [['install', 'codex']]);
  assert.equal(h.views.at(-1)!.tone, 'error');
  const claude = harness({ report: missing('claude'), rpc: { add: async () => account('acc_new', 'claude') } });
  await startPlanSetup('claude', claude.env).done;
  assert.equal(claude.views[0].text, 'Installing Claude Code – this takes about a minute…');
});

test('cancel while waiting stops the flow and shows nothing more', async () => {
  const h = harness();
  const flow = startPlanSetup('codex', h.env);
  await until(() => h.timers.length === 1, 'waiting');
  const shown = h.views.length;
  flow.cancel();
  assert.deepEqual(await flow.done, { ok: false, reason: 'cancelled', message: '' });
  assert.equal(h.views.length, shown);
  assert.equal(h.timers[0].cancelled, true);
  assert.equal(h.focus.size, 0);
});

test('cancelling during installation stops before adding the account', async () => {
  let installedDone: (() => void) | undefined;
  const h = harness({ report: missing('codex'), rpc: { install: () => new Promise<void>((resolve) => { installedDone = resolve; }) } });
  const flow = startPlanSetup('codex', h.env);
  flow.cancel();
  installedDone!();
  assert.deepEqual(await flow.done, { ok: false, reason: 'cancelled', message: '' });
  assert.deepEqual(h.calls, [['install', 'codex']]);
});

test('a removed sign-in ends the wait', async () => {
  const h = harness();
  const flow = startPlanSetup('codex', h.env);
  await until(() => h.timers.length === 1, 'waiting');
  h.accounts.value = [account('acc_new', 'codex', { state: 'needs_login' })];
  h.accounts.value = [];
  assert.deepEqual(await flow.done, { ok: false, reason: 'sign-in', message: 'The sign-in was removed – try again.' });
});

test('only an explicitly missing CLI triggers installation', () => {
  assert.equal(cliMissing(missing('codex'), 'codex'), true);
  assert.equal(cliMissing(installed('codex'), 'codex'), false);
  assert.equal(cliMissing(report([]), 'codex'), false, 'not listed: adding lets the runtime decide');
  assert.equal(cliMissing(null, 'claude'), false);
});

test('the model setup retains the plan buttons and the reserved sign-in link cell', () => {
  const ui = path.resolve(import.meta.dirname, '..', '..', '..', 'src', 'ui');
  const read = (file: string) => readFileSync(path.join(ui, file), 'utf8');
  assert.deepEqual(PLAN_LABELS, { claude: 'Claude plan', codex: 'Codex plan' });
  const actions = read('onboarding/plan-actions.tsx');
  assert.ok(actions.includes('busy={running === provider}'), 'busy on the pressed button only');
  const setup = read('settings/ModelSetup.tsx');
  for (const part of ['<PlanButtons ', '>API key<', '>Local server<', '<SignInLink url=']) assert.ok(setup.includes(part), part);
  assert.doesNotMatch(setup, /Add a connection|Best connected model/);
  const link = read('onboarding/sign-in-link.tsx');
  assert.ok(link.includes('class={`first-run-link inert${extra}`} aria-hidden="true">{OPEN_SIGN_IN}'), 'the placeholder holds the same text');
  const card = read('onboarding/AiCard.tsx');
  assert.ok(card.includes('disabled={silent}') && !card.includes('Skip'), 'Continue waits for a usable model');
  assert.ok(card.includes('<ModelSetup />'), 'first run and Settings share the setup');
  assert.doesNotMatch(setup, /uses=|\bdecision\b|\bembeddings\b/i);
  assert.ok(setup.includes('<ConnectionForm '));
});
