// AF-013: each engine enforces the mode with its own means – Claude Code's permission mode, disallowed tools and the
// hub's permission prompt tool; Codex's sandbox and approval policy, its approval requests judged per step; ACP's
// permission requests; without a policy every engine runs exactly as before AF-013.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permissionArgs, PERMISSION_TOOL } from '../../../src/runtime/engines/claude/access.ts';
import { accessPermissions, changePaths } from '../../../src/runtime/engines/codex/access.ts';
import { turnPermissions } from '../../../src/runtime/engines/codex/isolation.ts';
import { approvalResponse } from '../../../src/runtime/engines/codex/approvals.ts';
import { acpActions, claudeActions, codexActions, toolActions } from '../../../src/runtime/access/classify.ts';
import { answerPrompt, promptToolWanted, ACCESS_PROMPT_SPEC } from '../../../src/runtime/access/prompt-tool.ts';
import { turnAccessPolicy } from '../../../src/runtime/access/turn.ts';
import { toWireName } from '../../../src/runtime/engines/shared.ts';
import { AccessStore } from '../../../src/runtime/access/store.ts';
import { ApprovalBroker } from '../../../src/runtime/access/approvals.ts';
import { AccessService } from '../../../src/runtime/access/service.ts';
import type { TurnAccessPolicy } from '../../../src/runtime/engines/types.ts';
import type { AccessMode } from '../../../src/shared/model/access.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Agent } from '../../../src/shared/model/org.ts';

const policy = (mode: AccessMode, extra: Partial<TurnAccessPolicy> = {}): TurnAccessPolicy => ({ mode, writable: [], network: true, networkDenied: false, decide: async () => ({ allow: true, message: '' }), ...extra });

test('claude: bypassPermissions without a policy; its own modes and the hub prompt tool with one', () => {
  assert.deepEqual(permissionArgs(undefined), ['--permission-mode', 'bypassPermissions']);
  const read = permissionArgs(policy('read'));
  assert.deepEqual(read.slice(0, 6), ['--permission-mode', 'default', '--permission-prompt-tool', PERMISSION_TOOL, '--allowedTools', 'mcp__workforce']);
  assert.deepEqual(read.slice(read.indexOf('--disallowedTools') + 1), ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'], 'read only: no edit tool');
  assert.equal(permissionArgs(policy('ask'))[1], 'default');
  assert.ok(!permissionArgs(policy('ask')).includes('--disallowedTools'));
  const project = permissionArgs(policy('project', { writable: ['/home/ada/notes'] }));
  assert.equal(project[1], 'acceptEdits');
  assert.deepEqual(project.slice(project.indexOf('--add-dir')), ['--add-dir', '/home/ada/notes']);
  assert.ok(permissionArgs(policy('full', { networkDenied: true })).join(' ').endsWith('--disallowedTools WebSearch WebFetch'));
  assert.equal(PERMISSION_TOOL, `mcp__workforce__${toWireName(ACCESS_PROMPT_SPEC.name)}`, 'the name the hub lists');
});

test('codex: today\'s settings without a policy or on a read turn; sandbox and approval policy per mode', () => {
  assert.deepEqual(accessPermissions(undefined, 'full', '/w'), turnPermissions('full'));
  assert.deepEqual(accessPermissions(policy('full'), 'read', '/w'), turnPermissions('read'), 'a helper stays read-only');
  assert.deepEqual(accessPermissions(policy('read', { network: false }), 'full', '/w'), { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
  const ask = accessPermissions(policy('ask', { writable: ['/notes'] }), 'full', '/w');
  assert.equal(ask.approvalPolicy, 'untrusted');
  assert.deepEqual((ask.sandboxPolicy as { writableRoots: string[] }).writableRoots, ['/w', '/notes']);
  assert.equal(accessPermissions(policy('project'), 'full', '/w').approvalPolicy, 'on-request');
  assert.deepEqual(accessPermissions(policy('full'), 'full', '/w').sandboxPolicy, { type: 'dangerFullAccess' });
  assert.deepEqual(changePaths({ type: 'fileChange', changes: [{ path: '/w/a.ts', kind: 'update' }, { kind: 'add' }] }), ['/w/a.ts']);
  assert.deepEqual(approvalResponse('item/commandExecution/requestApproval', {}, true, true), { decision: 'accept' }, 'once: this step only');
  assert.deepEqual(approvalResponse('item/commandExecution/requestApproval', {}, true), { decision: 'acceptForSession' }, 'as before without a policy');
});

test('engine steps as actions', () => {
  assert.deepEqual(claudeActions('Bash', { command: 'npm test' }, '/w'), [{ kind: 'command', command: 'npm test', cwd: '/w' }]);
  assert.deepEqual(claudeActions('Write', { file_path: '/w/a.md', content: 'x' }, '/w'), [{ kind: 'write', path: '/w/a.md' }]);
  assert.deepEqual(claudeActions('WebFetch', { url: 'https://x.example' }, '/w'), [{ kind: 'network', target: 'https://x.example' }]);
  assert.deepEqual(claudeActions('TodoWrite', {}, '/w'), []);
  assert.deepEqual(claudeActions('mcp__github__create_issue', {}, '/w'), [{ kind: 'tool', name: 'mcp__github__create_issue' }]);
  assert.deepEqual(codexActions('item/commandExecution/requestApproval', { command: 'rm -rf build', cwd: '/w/app' }, '/w'), [{ kind: 'command', command: 'rm -rf build', cwd: '/w/app' }]);
  assert.deepEqual(codexActions('execCommandApproval', { command: ['git', 'push'] }, '/w'), [{ kind: 'command', command: 'git push', cwd: '/w' }]);
  assert.deepEqual(codexActions('item/fileChange/requestApproval', { itemId: 'i1' }, '/w', ['/w/a.ts']), [{ kind: 'write', path: '/w/a.ts' }]);
  assert.deepEqual(codexActions('applyPatchApproval', { fileChanges: { '/x/b.ts': {} } }, '/w'), [{ kind: 'write', path: '/x/b.ts' }]);
  assert.deepEqual(codexActions('item/permissions/requestApproval', { permissions: { network: { enabled: true } } }, '/w'), [{ kind: 'network' }]);
  assert.deepEqual(acpActions({ kind: 'execute', title: 'npm install', rawInput: { command: 'npm install' } }, '/w'), [{ kind: 'command', command: 'npm install', cwd: '/w' }]);
  assert.deepEqual(acpActions({ kind: 'delete', locations: [{ path: '/w/old.txt' }] }, '/w'), [{ kind: 'write', path: '/w/old.txt', delete: true }]);
  assert.deepEqual(acpActions({ kind: 'fetch' }, '/w'), [{ kind: 'network' }]);
  assert.deepEqual(toolActions({ name: 'shell.exec', category: 'write_system' }, { command: 'ls', cwd: '/w' }), [{ kind: 'command', command: 'ls', cwd: '/w' }]);
  assert.deepEqual(toolActions({ name: 'app.stripe.create_charge', category: 'write_system' }, {}), [{ kind: 'tool', name: 'app.stripe.create_charge', category: 'write_system' }, { kind: 'spend', name: 'app.stripe.create_charge' }]);
  assert.deepEqual(toolActions({ name: 'tasks.create', category: 'think' }, {}), []);
});

function services(mode?: AccessMode) {
  const store = new AccessStore({ now: () => 1 });
  const asked: string[] = [];
  const broker = new ApprovalBroker({ emit: (event: string, data: unknown) => { if (event === 'access.requested') { asked.push((data as { summary: string }).summary); queueMicrotask(() => broker.answer((data as { id: string }).id, 'deny')); } }, now: () => 1, id: () => 'acr_000000000001' });
  const access = new AccessService({ store, broker, emit: () => undefined, workspace: () => '/w', home: () => '/w/app', agentName: () => 'Tom', platform: 'linux' });
  if (mode) access.set('ag_tom', { mode });
  return { s: { access, paths: { workspace: '/w' } } as unknown as RuntimeServices, asked };
}

const ctx = { agent: { id: 'ag_tom' } as Agent, conversationId: 'ch_1', runId: 'run_1' };

test('the hub\'s permission prompt tool: listed only for a limited turn; answers in Claude Code\'s format', async () => {
  assert.equal(promptToolWanted(services().s, ctx), false, 'full access: not listed, bypassPermissions as before');
  assert.equal(turnAccessPolicy(services().s, { agentId: 'ag_tom' }), undefined, 'no policy without limits');
  const read = services('read');
  assert.equal(promptToolWanted(read.s, ctx), true);
  const deniedOut = await answerPrompt(read.s, ctx, { tool_name: 'Bash', input: { command: 'rm -rf src' } }, new AbortController().signal);
  const denied = JSON.parse((deniedOut.content[0] as { text: string }).text);
  assert.equal(denied.behavior, 'deny');
  assert.match(denied.message, /read only/);
  const allowed = await answerPrompt(read.s, ctx, { tool_name: 'Bash', input: { command: 'git status' } }, new AbortController().signal);
  assert.deepEqual(JSON.parse((allowed.content[0] as { text: string }).text), { behavior: 'allow', updatedInput: { command: 'git status' } });
  const hub = await answerPrompt(read.s, ctx, { tool_name: 'mcp__workforce__files__write', input: { path: 'x' } }, new AbortController().signal);
  assert.equal(JSON.parse((hub.content[0] as { text: string }).text).behavior, 'allow', 'the registry judges the hub\'s own tools');
  const ask = services('ask');
  const answered = await answerPrompt(ask.s, ctx, { tool_name: 'Edit', input: { file_path: '/w/app/a.ts' } }, new AbortController().signal);
  assert.equal(JSON.parse((answered.content[0] as { text: string }).text).behavior, 'deny', 'the person denied it');
  assert.deepEqual(ask.asked, ['Change /w/app/a.ts']);
  const turn = turnAccessPolicy(ask.s, { agentId: 'ag_tom', cwd: '/w/app' })!;
  assert.equal(turn.mode, 'ask');
  assert.equal((await turn.decide('acp', [{ kind: 'command', command: 'git status' }], new AbortController().signal)).allow, true);
});
