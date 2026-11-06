// Detection → accounts (PR5, accounts/adoption.ts + dismissed.ts): a login in the default CLI home
// and a running local server become 'detected' accounts once (detecting again is idempotent);
// removing one dismisses it – detection, also after a restart, no longer adds it and the report
// marks it – until "Add again" (accounts.add {detected} for a login, adding the server's URL).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DismissedLogins, dismissalKey } from '../../../src/runtime/accounts/dismissed.ts';
import { harness } from './harness.ts';

const OLLAMA = 'http://127.0.0.1:11434/v1';

/** Ollama 0.36 with one model on its default port; every other probe finds nothing. */
async function ollama(url: string): Promise<Response> {
  if (url === 'http://127.0.0.1:11434/api/version') return Response.json({ version: '0.36.1' });
  if (url === 'http://127.0.0.1:11434/api/tags') return Response.json({ models: [{ name: 'gemma4:31b' }] });
  throw new Error('offline');
}

test('adoption: the default-home Codex login and the local Ollama server are added once; detecting again changes nothing', async () => {
  const h = harness({ fetch: ollama });
  await h.service.detect();
  await h.settle();
  const codex = h.service.list().find((account) => account.provider === 'codex')!;
  const server = h.service.list().find((account) => account.provider === 'ollama')!;
  assert.deepEqual([codex.auth, codex.home, codex.detected, codex.state, codex.plan], ['cli', undefined, true, 'ok', 'pro']);
  assert.deepEqual([server.auth, server.baseUrl, server.detected], ['local', OLLAMA, true]);
  assert.equal(h.service.list().length, 2, 'Claude Code is installed but not signed in: nothing to adopt');
  assert.deepEqual(h.checks, [codex.id], 'one check for the adopted plan');

  await h.service.detect(true);
  await h.settle();
  assert.equal(h.service.list().length, 2);
  assert.equal(h.checks.length, 1);
});

test('lastDetection: the newest report without a scan – every rescan replaces it (RT7)', async () => {
  const h = harness({ fetch: ollama });
  assert.equal(h.service.lastDetection(), undefined, 'nothing before the first detection');
  const first = await h.service.detect();
  assert.equal(h.service.lastDetection()?.checkedAt, first.checkedAt);
  const scans = h.calls.length;
  h.clock.advance(60_000);
  assert.equal(h.service.lastDetection()?.checkedAt, first.checkedAt, 'reading it starts no scan');
  assert.equal(h.calls.length, scans);
  const again = await h.service.detect(true);
  assert.notEqual(again.checkedAt, first.checkedAt);
  assert.equal(h.service.lastDetection()?.checkedAt, again.checkedAt, 'a Settings rescan shows at once');
});

test('dismissal: a removed detected login or server stays away – also after a restart – until "Add again"', async () => {
  const h = harness({ fetch: ollama });
  await h.service.detect();
  for (const account of h.service.list()) await h.service.remove(account.id);
  assert.deepEqual(h.removed, [], 'the default CLI home and a server are never deleted');
  assert.deepEqual(new DismissedLogins(h.db, () => 0).list(), ['codex:default', `ollama:${OLLAMA}`]);
  const scans = h.calls.length;
  const last = h.service.lastDetection();
  assert.deepEqual([last?.clis.find((cli) => cli.provider === 'codex')?.dismissed, last?.localServers[0]?.dismissed], [true, true], 'lastDetection marks them like detect() (RT7)');
  assert.equal(h.calls.length, scans, 'without a scan');

  let report = await h.service.detect(true);
  assert.equal(h.service.list().length, 0, 'detection does not add them back');
  assert.equal(report.clis.find((cli) => cli.provider === 'codex')?.dismissed, true);
  assert.equal(report.clis.find((cli) => cli.provider === 'claude')?.dismissed, undefined);
  assert.equal(report.localServers[0]?.dismissed, true);
  assert.equal((await h.service.detect()).clis.find((cli) => cli.provider === 'codex')?.dismissed, true, 'the cached report is marked too');

  const restarted = harness({ fetch: ollama, db: h.db }); // the same database after a restart
  await restarted.service.detect();
  assert.equal(restarted.service.list().length, 0);

  // "Add again": the login through accounts.add {detected}, the server by adding its URL.
  const again = await h.service.add({ provider: 'codex', detected: true });
  assert.deepEqual([again.provider, again.auth, again.home, again.detected], ['codex', 'cli', undefined, true]);
  await h.service.add({ provider: 'ollama', baseUrl: OLLAMA, label: 'Ollama' });
  report = await h.service.detect(true);
  assert.equal(h.service.list().length, 2, 'nothing is doubled');
  assert.ok(!report.clis.some((cli) => cli.dismissed) && !report.localServers.some((entry) => entry.dismissed));
  assert.deepEqual(new DismissedLogins(h.db, () => 0).list(), []);
});

test('"Add again" needs a sign-in found on this PC', async () => {
  const h = harness();
  h.login.codex = false; // nothing signed in on this PC
  await assert.rejects(h.service.add({ provider: 'claude', detected: true }), /No Claude Code sign-in was found on this PC/);
  await assert.rejects(h.service.add({ provider: 'openai', detected: true }), /Only a sign-in found on this PC/);
  assert.equal(h.service.list().length, 0);
});

test('dismissal keys: a default-home login and a local server; isolated homes, keys and environment keys never', () => {
  const base = { home: undefined, baseUrl: undefined };
  assert.equal(dismissalKey({ ...base, provider: 'claude', auth: 'cli' }), 'claude:default');
  assert.equal(dismissalKey({ ...base, provider: 'claude', auth: 'cli', home: '/data/accounts/claude/acc_1' }), undefined);
  assert.equal(dismissalKey({ ...base, provider: 'lmstudio', auth: 'local', baseUrl: 'http://127.0.0.1:1234/v1' }), 'lmstudio:http://127.0.0.1:1234/v1');
  assert.equal(dismissalKey({ ...base, provider: 'openai', auth: 'api_key' }), undefined);
  assert.equal(dismissalKey({ ...base, provider: 'openai', auth: 'env' }), undefined);
  const store = new DismissedLogins(harness().db, () => 1);
  for (let index = 0; index < 120; index++) store.add(`ollama:http://127.0.0.1:${index}/v1`);
  store.add('ollama:http://127.0.0.1:5/v1'); // again: moves to the end, no duplicate
  const list = store.list();
  assert.equal(list.length, 100, 'bounded');
  assert.equal(list.at(-1), 'ollama:http://127.0.0.1:5/v1');
  assert.equal(new Set(list).size, list.length);
  assert.equal(store.delete('ollama:http://127.0.0.1:119/v1'), true);
  assert.equal(store.delete('ollama:http://127.0.0.1:119/v1'), false);
});
