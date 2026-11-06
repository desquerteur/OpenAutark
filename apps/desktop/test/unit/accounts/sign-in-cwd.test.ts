// Sign-in and sign-out processes start in their own folder, never in the runtime's process cwd (which
// may lie inside the workspace): Claude Code's `auth login|logout` take no --setting-sources, so a
// planted `.claude/settings.json` there would hand them its env and apiKeyHelper. Covers the headless
// browser flows (Claude Code, Codex) and the visible terminal window (Kimi Code's `kimi login`, B-044).
// Owns: nothing in production. Never starts a real CLI or terminal (scripted supervisor).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { SignIns } from '../../../src/runtime/accounts/sign-in.ts';
import { account, fakeFinder, fakeSpawn, testSupervisor } from '../engines/fakes.ts';

const CWD = '/fake-data/tmp';

function signIns(cwd?: string) {
  // Sign-outs finish at once; sign-in processes and terminal windows stay open until dispose().
  const { spawn, calls } = fakeSpawn((call) => { if (call.args.includes('logout')) setImmediate(() => call.child.exit(0)); });
  const service = new SignIns({
    finder: fakeFinder({ claude: '/bin/claude', codex: '/bin/codex', kimi: '/bin/kimi' }),
    supervisor: testSupervisor(spawn), env: { PATH: '/usr/bin', SystemRoot: 'C:\\Windows' }, now: () => 0, urlWaitMs: 0,
    label: (provider) => provider, check: async () => {}, state: () => 'ok', terminal: { platform: 'win32' },
    ...(cwd ? { cwd } : {}),
  });
  return { service, calls };
}

test('sign-in cwd: Claude Code and Codex sign-ins and sign-outs start in the given folder, the account home still in the env', async () => {
  const { service, calls } = signIns(CWD);
  const claude = account({ id: 'acc_claude', provider: 'claude', home: '/fake-data/accounts/claude/acc_claude' });
  await service.login(claude);
  assert.equal(await service.logout(claude), 'done');
  await service.login(account({ id: 'acc_codex', provider: 'codex', home: '/fake-data/accounts/codex/acc_codex' }));
  assert.deepEqual(calls.map((call) => call.args.join(' ')), ['auth login --claudeai', 'auth logout', 'login']);
  for (const call of calls) assert.equal(call.options.cwd, CWD, `${call.args.join(' ')}: never the process cwd`);
  assert.equal(calls[0].options.env?.CLAUDE_CONFIG_DIR, '/fake-data/accounts/claude/acc_claude');
  await service.dispose();
});

test('sign-in cwd: without a folder the OS temp folder is used; the Kimi Code terminal window starts there too, in its own home', async () => {
  const { service, calls } = signIns();
  await service.login(account({ id: 'acc_default', provider: 'claude' })); // default CLI home: no CLAUDE_CONFIG_DIR
  await service.login(account({ id: 'acc_kimi', provider: 'kimi-cli', home: '/fake-data/accounts/kimi-cli/acc_kimi' }));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.cwd, os.tmpdir());
  assert.equal(calls[0].options.env?.CLAUDE_CONFIG_DIR, undefined);
  assert.match(calls[1].command, /powershell\.exe$/i, 'the visible terminal launcher');
  assert.equal(calls[1].options.cwd, os.tmpdir(), 'the window inherits the launcher folder');
  assert.equal(calls[1].options.env?.WORKFORCE_TERMINAL_EXE, '/bin/kimi', 'the kimi executable for provider kimi-cli');
  assert.equal(calls[1].options.env?.WORKFORCE_TERMINAL_ARGS, JSON.stringify(['login']));
  assert.equal(calls[1].options.env?.KIMI_CODE_HOME, '/fake-data/accounts/kimi-cli/acc_kimi');
  await service.dispose();
});
