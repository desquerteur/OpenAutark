// Which files hold a CLI plan's login and where a CLI's default home is (accounts/cli-homes.ts; the copy between the
// CEO's PCs: devices/sync/logins.ts): Codex auth.json, Claude Code .credentials.json (none on a Mac: the Keychain),
// Gemini CLI its two files; Copilot CLI and Kimi Code none known. Codex, Claude Code and Kimi Code accounts have
// homes of their own, Gemini CLI and Copilot CLI one sign-in per PC.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { defaultHome, loginFiles, ownHomes } from '../../../src/runtime/accounts/cli-homes.ts';

test('the login files per CLI, none where the login is no known file', () => {
  assert.deepEqual(loginFiles('codex', 'win32'), ['auth.json']);
  assert.deepEqual(loginFiles('claude', 'linux'), ['.credentials.json']);
  assert.deepEqual(loginFiles('claude', 'darwin'), [], 'a Mac keeps Claude Code\'s login in the Keychain');
  assert.deepEqual(loginFiles('gemini-cli', 'darwin'), ['oauth_creds.json', 'google_accounts.json']);
  for (const provider of ['copilot', 'kimi-cli', 'openai'] as const) assert.deepEqual(loginFiles(provider, 'win32'), [], provider);
});

test('default homes follow the CLIs\' own variables; own homes for Codex, Claude Code and Kimi Code only', () => {
  const home = path.join('C:', 'Users', 'lena');
  assert.equal(defaultHome('codex', {}, home), path.join(home, '.codex'));
  assert.equal(defaultHome('codex', { CODEX_HOME: 'D:\\codex' }, home), 'D:\\codex');
  assert.equal(defaultHome('claude', { CLAUDE_CONFIG_DIR: 'D:\\claude' }, home), 'D:\\claude');
  assert.equal(defaultHome('gemini-cli', {}, home), path.join(home, '.gemini'));
  assert.equal(defaultHome('copilot', {}, home), undefined);
  assert.deepEqual(['codex', 'claude', 'kimi-cli', 'gemini-cli', 'copilot'].map((provider) => ownHomes(provider as never)), [true, true, true, false, false]);
});
