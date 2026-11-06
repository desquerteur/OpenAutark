// LIVE (opt-in): confirms the field names engines/claude/models.ts reads from Claude Code's
// `initialize` control response (models[].value / displayName / description /
// supportedEffortLevels / supportsEffort, account.email / subscriptionType) and that get_usage
// still answers in the same probe process. Sends only these two control requests – no model
// message, no tokens. Runs in the Claude Code config dir the person names (never the default home
// on its own) and reports key names and model ids only – never the e-mail, organization or any
// other account value.
//   WORKFORCE_LIVE=1 WORKFORCE_LIVE_CLAUDE_HOME=<CLAUDE_CONFIG_DIR of a signed-in account> node --test test/live/claude-initialize.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Account } from '../../src/shared/model/providers.ts';
import { ClaudeStatus } from '../../src/runtime/engines/claude/status.ts';
import { claudeModels, parseInitialize } from '../../src/runtime/engines/claude/models.ts';
import { Supervisor } from '../../src/runtime/system/supervisor.ts';
import { ExecutableFinder } from '../../src/runtime/accounts/executables.ts';
import { isRecord } from '../../src/runtime/engines/shared.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const home = process.env.WORKFORCE_LIVE_CLAUDE_HOME;
const live = process.env.WORKFORCE_LIVE === '1' && Boolean(home);

const keysOf = (items: unknown[]) => [...new Set(items.flatMap((item) => (isRecord(item) ? Object.keys(item) : [`(${typeof item})`])))].sort();

test('claude initialize: field names of models and account (opt-in probe)', { skip: live ? false : 'set WORKFORCE_LIVE=1 and WORKFORCE_LIVE_CLAUDE_HOME', timeout: 60_000 }, async (t) => {
  const exe = await new ExecutableFinder().find('claude');
  assert.ok(exe, 'Claude Code is installed');
  const tempDir = path.join(root, 'test-results', 'claude-probe');
  await mkdir(tempDir, { recursive: true });
  const supervisor = new Supervisor({});
  const account: Account = { id: 'live_probe', provider: 'claude', label: 'Claude', auth: 'cli', home, state: 'unknown', priority: 0, rotation: false, enabled: true, detected: false, createdAt: 0 };
  const raw = await new ClaudeStatus({ supervisor, tempDir }).read(exe, account);
  await supervisor.killAll();

  assert.ok(isRecord(raw.init), 'initialize answered with success');
  const init = raw.init;
  const models = Array.isArray(init.models) ? init.models : [];
  t.diagnostic(`initialize keys: ${Object.keys(init).sort().join(', ')}`);
  t.diagnostic(`model entry keys: ${keysOf(models).join(', ')}`);
  t.diagnostic(`model values: ${models.map((m) => (isRecord(m) ? String(m.value) : '?')).join(', ')}`);
  t.diagnostic(`account keys: ${isRecord(init.account) ? Object.keys(init.account).sort().join(', ') : '(none)'}`);
  t.diagnostic(`get_usage answered in the same process: ${raw.usage !== undefined}`);
  assert.ok(models.length > 0, 'initialize lists models');
  assert.ok(models.every((m) => isRecord(m) && typeof m.value === 'string'), 'models[].value');
  assert.ok(models.every((m) => isRecord(m) && typeof m.displayName === 'string'), 'models[].displayName');
  const mapped = claudeModels(parseInitialize(init));
  t.diagnostic(`mapped: ${mapped.map((m) => `${m.model}${m.contextTokens ? ` (${m.contextTokens})` : ''} [${m.efforts.join('/')}]`).join(', ')}`);
  assert.ok(mapped.length > 0);
});
