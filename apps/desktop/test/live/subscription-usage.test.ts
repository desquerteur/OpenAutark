// Opt-in official CLI status checks: no model messages, no credentials read by Workforce.
// Owns: evidence that installed Codex / Claude Code return normalized subscription windows.
// Never: prints raw responses, e-mail, tokens or account identifiers.
// WORKFORCE_LIVE=1 WORKFORCE_LIVE_CODEX_HOME=<home> WORKFORCE_LIVE_CLAUDE_HOME=<home> node --test test/live/subscription-usage.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { CodexEngine } from '../../src/runtime/engines/codex/engine.ts';
import { ClaudeStatus } from '../../src/runtime/engines/claude/status.ts';
import { ExecutableFinder } from '../../src/runtime/accounts/executables.ts';
import { Supervisor } from '../../src/runtime/system/supervisor.ts';
import type { Account } from '../../src/shared/model/providers.ts';

for (const provider of ['codex', 'claude'] as const) {
  const home = process.env[`WORKFORCE_LIVE_${provider.toUpperCase()}_HOME`];
  test(`${provider}: official status returns subscription limits, with no model call`, {
    skip: process.env.WORKFORCE_LIVE !== '1' || !home ? 'set WORKFORCE_LIVE=1 and the provider home' : false,
    timeout: 90_000,
  }, async (t) => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'workforce-quota-probe-'));
    const supervisor = new Supervisor({});
    t.after(async () => { await supervisor.killAll(); await rm(temp, { recursive: true, force: true }); });
    const finder = new ExecutableFinder();
    const account: Account = { id: 'live_quota', provider, label: provider, home, auth: 'cli',
      enabled: true, state: 'unknown', rotation: false, priority: 0, detected: false, createdAt: 0 };
    const began = Date.now();
    let check;
    if (provider === 'codex') {
      const engine = new CodexEngine({ supervisor, finder, cwd: temp, version: '0.2.0' });
      t.after(() => engine.dispose());
      check = await engine.checkAccount(account);
    } else {
      const exe = await finder.find('claude'); assert.ok(exe, 'official CLI installed');
      check = await new ClaudeStatus({ supervisor, tempDir: temp }).check(exe, account);
    }
    assert.equal(check.state, 'ok', 'official CLI confirms sign-in');
    assert.ok(check.limits?.windows.length, 'official CLI returns at least one quota window');
    assert.ok(check.limits.readAt >= began, 'reading timestamp belongs to this check');
    for (const window of check.limits.windows) {
      assert.ok(window.usedPercent >= 0 && window.usedPercent <= 100);
    }
    t.diagnostic(`elapsed ${Date.now() - began} ms; ${check.limits.windows.map((w) => `${w.name}: ${100 - w.usedPercent}% left`).join(', ')}`);
  });
}
