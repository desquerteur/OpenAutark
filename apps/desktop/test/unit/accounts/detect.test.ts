// PC scan (accounts/detect.ts) with a scripted supervisor and fake fetch: installed CLIs with
// version and default-home login state (provider keys stripped from their environment), local
// servers on their loopback ports, Tailscale, and the provider key variables by name only (the one
// env → provider table); plus the official status parsers (cli.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, ENV_KEYS } from '../../../src/runtime/accounts/detect.ts';
import { parseClaudeStatus, parseCodexStatus } from '../../../src/runtime/accounts/cli.ts';
import { childEnv, STRIPPED_ENV } from '../../../src/runtime/engines/codex/server.ts';
import { ENV_KEY_PROVIDERS, envKeyProvider } from '../../../src/shared/model/providers.ts';
import { fakeFinder, fakeSpawn, testSupervisor } from '../engines/fakes.ts';
import { ENV_KEY } from './harness.ts';

const offline = async (): Promise<Response> => { throw new Error('offline'); };

/** Each CLI answers its official commands like a signed-in default home. */
const ANSWERS: Record<string, string> = {
  '/bin/codex --version': 'codex-cli 0.129.0\n',
  '/bin/codex login status': 'Logged in using ChatGPT\n',
  '/bin/claude --version': '2.1.0 (Claude Code)\n',
  '/bin/claude auth status --json': JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'person@example.test' }),
  '/bin/tailscale status --json': JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'pc.tail1234.ts.net.' } }),
};

function scripted() {
  return fakeSpawn((call) => {
    const out = ANSWERS[[call.command, ...call.args].join(' ')];
    setImmediate(() => { if (out !== undefined) call.child.stdout.write(out); setImmediate(() => call.child.exit(out === undefined ? 1 : 0)); });
  });
}

test('detect: CLIs with version and login state, keys stripped from their environment; key variables by name only', async () => {
  const { spawn, calls } = scripted();
  const env = { OPENAI_API_KEY: ENV_KEY, GEMINI_API_KEY: '   ', XAI_API_KEY: '', SOME_TOKEN: 'secret', ARTIFICIAL_ANALYSIS_API_KEY: ENV_KEY, PATH: '/usr/bin' };
  const report = await detect({
    finder: fakeFinder({ codex: '/bin/codex', claude: '/bin/claude', tailscale: '/bin/tailscale' }),
    supervisor: testSupervisor(spawn), env, fetch: offline, probeTimeoutMs: 1, now: () => 42,
  });
  assert.deepEqual(report.clis, [
    { provider: 'codex', path: '/bin/codex', version: '0.129.0', loggedIn: true, method: 'chatgpt' },
    { provider: 'claude', path: '/bin/claude', version: '2.1.0', loggedIn: true, method: 'claude' },
    { provider: 'gemini-cli' }, // the ACP plan CLIs report their provider id (PR8)
    { provider: 'copilot' },
    { provider: 'kimi-cli' }, // B-044: Kimi Code on the ACP engine
  ]);
  assert.deepEqual(report.envKeys, ['OPENAI_API_KEY'], 'set and non-blank table names only');
  assert.deepEqual(report.tailscale, { running: true, dnsName: 'pc.tail1234.ts.net' });
  assert.deepEqual([report.localServers, report.checkedAt], [[], 42]);
  assert.ok(!JSON.stringify(report).includes(ENV_KEY), 'never a value');
  assert.ok(calls.length >= 5);
  for (const call of calls) {
    assert.equal(call.options.env?.OPENAI_API_KEY, undefined, `${call.args.join(' ')}: provider keys stripped`);
    assert.equal(call.options.env?.PATH, '/usr/bin');
  }
});

test('detect: local servers on their default loopback ports with their models', async () => {
  const asked: Array<{ url: string; redirect?: RequestRedirect }> = [];
  const ollamaVersion = '0.35.0';
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    asked.push({ url, redirect: init.redirect });
    if (url.endsWith(':11434/api/version')) return Response.json({ version: ollamaVersion });
    if (url.endsWith(':11434/api/tags')) return Response.json({ models: [{ name: 'gemma4:31b' }, { name: 42 }] });
    if (url.endsWith(':1234/v1/models')) return Response.json({ data: [{ id: 'qwen3-8b' }] });
    if (url.endsWith(':8080/health')) return Response.json({ status: 'ok' });
    if (url.endsWith(':8080/v1/models')) return Response.json({ data: [{ id: 'llama-3' }] });
    if (url.endsWith(':8000/v1/models')) return new Response('nope', { status: 500 });
    throw new Error('offline');
  };
  const scan = () => detect({ finder: fakeFinder({}), supervisor: testSupervisor(scripted().spawn), env: {}, fetch, probeTimeoutMs: 50 });
  const report = await scan();
  assert.deepEqual(report.localServers, [
    { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['gemma4:31b'] },
    { provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', models: ['qwen3-8b'] },
    { provider: 'llamacpp', baseUrl: 'http://127.0.0.1:8080/v1', models: ['llama-3'] },
  ]);
  assert.ok(asked.every((entry) => entry.url.startsWith('http://127.0.0.1:') && entry.redirect === 'error'), 'loopback only, no redirects');
  assert.equal(report.tailscale, undefined, 'no Tailscale installed');
});

test('the one env → provider table: detection names, prototype names refused, and every key variable stripped from CLI children', () => {
  assert.deepEqual([...ENV_KEYS], Object.keys(ENV_KEY_PROVIDERS));
  assert.equal(envKeyProvider('GOOGLE_API_KEY'), 'google');
  assert.equal(envKeyProvider('GEMINI_API_KEY'), 'google');
  assert.equal(envKeyProvider('ARTIFICIAL_ANALYSIS_API_KEY'), undefined, 'model data keys are gone');
  for (const name of ['constructor', '__proto__', 'toString', 'PATH']) assert.equal(envKeyProvider(name), undefined, name);
  for (const name of Object.keys(ENV_KEY_PROVIDERS)) assert.ok(STRIPPED_ENV.includes(name), `${name} never reaches a CLI`);
  assert.deepEqual(childEnv({ OLLAMA_API_KEY: 'k', XAI_API_KEY: 'k', PATH: '/bin' }, { HOME: '/h' }), { PATH: '/bin', HOME: '/h' });
});

test('parseCodexStatus: signed in only with exit 0 and "Logged in using/with …"; an API key login is told apart', () => {
  assert.deepEqual(parseCodexStatus(0, 'Logged in using ChatGPT\n'), { loggedIn: true, method: 'chatgpt' });
  assert.deepEqual(parseCodexStatus(0, 'Logged in using an API key - sk-proj-***ABCD\n'), { loggedIn: true, method: 'api' });
  assert.deepEqual(parseCodexStatus(0, 'note: update available\n  logged in with ChatGPT'), { loggedIn: true, method: 'chatgpt' });
  assert.deepEqual(parseCodexStatus(0, 'Not logged in\n'), { loggedIn: false, method: undefined });
  assert.deepEqual(parseCodexStatus(1, 'Logged in using ChatGPT\n'), { loggedIn: false, method: undefined });
  assert.deepEqual(parseCodexStatus(null, ''), { loggedIn: false, method: undefined });
});

test('parseClaudeStatus: the claude.ai login with e-mail and plan, an API key login, and anything else signed out', () => {
  const json = (value: unknown) => JSON.stringify(value);
  assert.deepEqual(parseClaudeStatus(0, json({ loggedIn: true, authMethod: 'claude.ai', email: 'person@example.test', subscriptionType: 'max' })),
    { loggedIn: true, method: 'claude', email: 'person@example.test', plan: 'max' });
  assert.deepEqual(parseClaudeStatus(0, json({ loggedIn: true, authMethod: 'api_key' })), { loggedIn: true, method: 'api', email: undefined, plan: undefined });
  assert.equal(parseClaudeStatus(0, json({ loggedIn: true, authMethod: 'claude.ai', email: 'x'.repeat(500) })).email?.length, 200);
  assert.deepEqual(parseClaudeStatus(0, json({ loggedIn: false })), { loggedIn: false });
  assert.deepEqual(parseClaudeStatus(1, json({ loggedIn: true })), { loggedIn: false });
  assert.deepEqual(parseClaudeStatus(0, 'Error: not json'), { loggedIn: false, unknown: true });
  assert.deepEqual(parseClaudeStatus(null, ''), { loggedIn: false, unknown: true });
});
