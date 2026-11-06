// B-051 L4: the sign-in page is visible – a headless sign-in (`codex login`, `claude auth login --claudeai`)
// pipes stdout and stderr (stdin stays closed), the first https URL on a known sign-in host is kept in
// memory while the process runs, login() waits at most 4 s for it, and add() hands it back as signInUrl.
// It is never logged, never stored and gone when the process exits; other hosts, http and output past
// the scan cap never count. Only the person's own UI asks for it (accounts.login/add); agent tools never do.
// Owns: nothing in production. Never starts a real CLI (scripted children).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignIns, URL_WAIT_MS } from '../../../src/runtime/accounts/sign-in.ts';
import { SCAN_CHARS, findSignInUrl, isSignInHost } from '../../../src/runtime/accounts/sign-in-url.ts';
import { Supervisor } from '../../../src/runtime/system/supervisor.ts';
import { HandlerTable, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { register as registerProviders } from '../../../src/runtime/rpc/handlers/providers.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { account, fakeFinder, fakeOs, fakeSpawn, tick, type SpawnCall } from '../engines/fakes.ts';
import { harness } from './harness.ts';

const CODEX_URL = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_test&state=s1';
const CLAUDE_URL = 'https://claude.ai/oauth/authorize?code=true&client_id=c1&state=s2';

test('the allow-list: known sign-in hosts and their subdomains only; http, user info, ports and look-alikes never count', () => {
  for (const host of ['auth.openai.com', 'chatgpt.com', 'openai.com', 'claude.ai', 'claude.com', 'anthropic.com', 'console.anthropic.com', 'platform.claude.com', 'AUTH.OPENAI.COM']) assert.ok(isSignInHost(host), host);
  for (const host of ['chatgpt.com.evil.io', 'evilchatgpt.com', 'claude.ai-login.net', 'localhost', 'example.com']) assert.ok(!isSignInHost(host), host);
  assert.equal(findSignInUrl(`Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\n${CODEX_URL}\n`), CODEX_URL);
  assert.equal(findSignInUrl(`see https://example.com/help then ${CLAUDE_URL}.`), CLAUDE_URL, 'the first URL on a known host; trailing punctuation dropped');
  assert.equal(findSignInUrl(`\u001b[1m${CLAUDE_URL}\u001b[0m`), CLAUDE_URL, 'colour codes stripped');
  for (const text of ['http://auth.openai.com/oauth', 'https://user:pw@claude.ai/x', 'https://claude.ai:8443/x', 'https://chatgpt.com.evil.io/auth', 'no url here']) assert.equal(findSignInUrl(text), undefined, text);
});

/** SignIns whose headless sign-ins print what `print` writes; a log spy on the supervisor. */
function rig(print: (call: SpawnCall) => void = () => {}, urlWaitMs?: number) {
  const logged: unknown[] = [];
  const { spawn, calls } = fakeSpawn((call) => { if (call.args.includes('logout')) setImmediate(() => call.child.exit(0)); else print(call); });
  const supervisor = new Supervisor({ spawn, os: fakeOs(), killTree: async () => {}, log: { warn: (...args: unknown[]) => { logged.push(args); } } });
  const service = new SignIns({
    finder: fakeFinder({ codex: '/bin/codex', claude: '/bin/claude' }), supervisor, env: {}, now: () => 0,
    label: (provider) => provider, check: async () => {}, state: () => 'needs_login', ...(urlWaitMs === undefined ? {} : { urlWaitMs }),
  });
  return { service, calls, logged };
}

/** Writes the lines on the next turn, like a CLI that just started. */
const later = (stream: NodeJS.WritableStream, ...chunks: string[]) => setImmediate(() => { for (const chunk of chunks) stream.write(chunk); });

test('codex login: stdout and stderr are piped, stdin closed; the printed page comes back from login() well before the 4 s cap', async () => {
  const r = rig((call) => later(call.child.stdout, 'Starting local login server on http://localhost:1455.\n', 'If your browser did not open, navigate to this URL to authenticate:\n\n', `${CODEX_URL.slice(0, 30)}`, `${CODEX_URL.slice(30)}\n`));
  const started = Date.now();
  const result = await r.service.login(account({ id: 'acc_codex', provider: 'codex' }));
  assert.ok(Date.now() - started < 1_500, 'answered when the URL was printed, not after the cap');
  assert.deepEqual(result, { started: true, url: CODEX_URL }, 'a URL split over chunks counts once its line is complete');
  assert.deepEqual(r.calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(URL_WAIT_MS, 4_000);
  // A second login while it runs: the same page at once, no second process.
  assert.deepEqual(await r.service.login(account({ id: 'acc_codex', provider: 'codex' })), { started: true, url: CODEX_URL });
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.logged, [], 'nothing logged');
  // Sign-outs stay without pipes.
  await r.service.logout(account({ id: 'acc_other', provider: 'codex' }));
  assert.deepEqual(r.calls[1].options.stdio, ['ignore', 'ignore', 'ignore']);
  await r.service.dispose();
});

test('claude auth login: a page printed on stderr counts; it is gone when the process exits', async () => {
  let first = true;
  const r = rig((call) => {
    if (!first) return later(call.child.stdout, 'nothing useful\n');
    first = false;
    later(call.child.stderr, `Opening browser to sign in…\nIf the browser didn't open, visit: ${CLAUDE_URL}\n`);
  }, 100);
  const claude = account({ id: 'acc_claude', provider: 'claude', home: '/data/accounts/claude/acc_claude' });
  assert.deepEqual(await r.service.login(claude), { started: true, url: CLAUDE_URL });
  assert.deepEqual(r.calls[0].args, ['auth', 'login', '--claudeai']);
  r.calls[0].child.exit(0);
  await tick();
  // The next login is a new process; the ended one's page is not handed out again.
  assert.deepEqual(await r.service.login(claude), { started: true });
  assert.equal(r.calls.length, 2);
  await r.service.dispose();
});

test('the wait is capped: no page printed → login() returns after urlWaitMs without one; a process that ends stops the wait at once', async () => {
  const quiet = rig(() => {}, 60);
  const started = Date.now();
  assert.deepEqual(await quiet.service.login(account({ id: 'acc_q', provider: 'codex' })), { started: true });
  const waited = Date.now() - started;
  assert.ok(waited >= 50 && waited < 1_500, `waited ${waited} ms`);
  await quiet.service.dispose();

  const ends = rig((call) => setImmediate(() => call.child.exit(1)), 5_000);
  const begin = Date.now();
  assert.deepEqual(await ends.service.login(account({ id: 'acc_e', provider: 'codex' })), { started: true });
  assert.ok(Date.now() - begin < 1_500, 'no wait for a process that already ended');
  await ends.service.dispose();
});

test('only a known host counts, and output past the scan cap is never read', async () => {
  const other = rig((call) => later(call.child.stdout, 'Visit https://chatgpt.com.evil.io/login to continue\n'), 30);
  assert.deepEqual(await other.service.login(account({ id: 'acc_o', provider: 'codex' })), { started: true });
  await other.service.dispose();

  const junk = `${'x'.repeat(1_000)}\n`.repeat(Math.ceil(SCAN_CHARS / 1_000) + 1);
  const flood = rig((call) => later(call.child.stdout, junk, `${CODEX_URL}\n`), 50);
  assert.deepEqual(await flood.service.login(account({ id: 'acc_f', provider: 'codex' })), { started: true });
  await flood.service.dispose();
});

test('never logged or stored: add() hands the page back as signInUrl, the stored account and its events never carry it', async () => {
  const seen: string[] = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const name of Object.keys(original) as Array<keyof typeof original>) console[name] = (...args: unknown[]) => { seen.push(args.map(String).join(' ')); };
  try {
    const h = harness({ signInUrlMs: 2_000 });
    const pending = h.service.add({ provider: 'codex', label: 'Work' });
    while (!h.signIns.length) await tick();
    const signIn = h.signIns[0];
    assert.deepEqual(signIn.options.stdio, ['ignore', 'pipe', 'pipe']);
    signIn.child.stdout.write(`navigate to this URL to authenticate:\n${CODEX_URL}\n`);
    const added = await pending;
    assert.equal(added.signInUrl, CODEX_URL);
    assert.equal((h.service.get(added.id) as unknown as Record<string, unknown>).signInUrl, undefined, 'not in the accounts table');
    assert.ok(!JSON.stringify(h.service.list()).includes('oauth'), 'no stored row carries it');
    assert.ok(!JSON.stringify(h.upserts).includes('oauth'), 'no account event carries it');
    assert.deepEqual(await h.service.login(added.id, { page: true }), { started: true, url: CODEX_URL }, 'accounts.login answers it while the sign-in runs');
    assert.deepEqual(await h.service.login(added.id), { started: true }, 'an agent tool (no page) never gets it – its output is stored with the run');
    signIn.child.exit(0);
    await h.settle();
    await h.service.dispose();
  } finally {
    Object.assign(console, original);
  }
  assert.ok(!seen.some((line) => line.includes('oauth') || line.includes('auth.openai.com')), 'nothing printed the page');
});

test('a sign-in started without page (the agent tool path) does not wait for one; the RPC asks for it', async () => {
  const r = rig(() => {}, 5_000);
  const begin = Date.now();
  assert.deepEqual(await r.service.login(account({ id: 'acc_tool', provider: 'codex' }), false), { started: true });
  assert.ok(Date.now() - begin < 1_500, 'no wait');
  await r.service.dispose();

  const table = new HandlerTable();
  registerProviders(table);
  const asked: unknown[][] = [];
  const services = { accounts: { login: async (...args: unknown[]) => { asked.push(args); return { started: true, url: CODEX_URL }; } } } as unknown as RuntimeServices;
  const ctx = { scope: { kind: 'owner' }, services, extras: {}, topics: new Set(), signal: new AbortController().signal, secure: true } as unknown as HandlerContext;
  assert.deepEqual(await table.get('accounts.login')!.handler({ id: 'acc_1' } as never, ctx), { started: true, url: CODEX_URL });
  assert.deepEqual(asked, [['acc_1', { page: true }]]);
});
