// B-057 live test L5 (Codex, 30.10.): a worktree part tried to commit itself – its sandbox may not write the repository's
// git metadata, the escalation was denied, and the part reported "no commit" although the app commits its work on its
// branch when it ends (splits/runner.ts finishThenEnd). The 'split' section now has a worktree part leave its work uncommitted, and
// agents.split's description says the app commits a part's work. A part in the shared folder keeps its own rule.
// Owns: nothing in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSection } from '../../../src/runtime/context/split-section.ts';
import { splitTools } from '../../../src/runtime/tools/builtin/agents-split.ts';
import type { SplitView } from '../../../src/shared/model/splits.ts';

const part = (patch: Partial<SplitView>): SplitView => ({
  id: 'spl_1', groupId: 'sgr_1', agentId: 'ag_1', idx: 1, of: 2, title: 'Alpha status', brief: 'Change alpha.txt', context: 'brief',
  after: [], worktree: false, status: 'running', attempts: 1, createdAt: 1, runs: 1, ...patch,
});

test('a worktree part is told not to commit: the app commits its work on its branch', () => {
  const text = splitSection({ name: 'Manager' }, { split: part({ worktree: true, branch: { name: 'wf/split-alpha-status-abc123' } }) });
  assert.match(text, /own git worktree \(branch wf\/split-alpha-status-abc123\)/);
  assert.match(text, /leave it uncommitted: the app commits my work on that branch when I end/);
});

test('a part in the shared folder keeps the shared-folder rule', () => {
  const text = splitSection({ name: 'Manager' }, { split: part({}) });
  assert.match(text, /share the working folder with the other parts/);
  assert.doesNotMatch(text, /uncommitted/);
});

test("agents.split's description says the app commits a worktree part's work", () => {
  const split = splitTools.find((tool) => tool.name === 'agents.split')!;
  assert.match(split.description, /commit first; the app commits its work; merge with agents\.split_merge/);
  assert.ok(split.description.length <= 900, `${split.description.length} characters`);
});
