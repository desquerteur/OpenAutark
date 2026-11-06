// X08: a runtime helper turn on Claude Code (no hub, no tools – decisions, verifier, compaction,
// the quarantined reader) keeps no transcript (`--no-session-persistence`) and passes `--tools ''`, so
// none of Claude Code's own tools run, also those that never prompt (a schema turn keeps the answer
// tool --json-schema uses, measured live 02.11.2026). An agent turn keeps its session and, since B-049 F2,
// the built-in execution core (`--tools` with the core list, lean.ts).
// Owns: nothing in production. Never starts a real binary (scripted CLI from claude-fixture.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coreTools } from '../../../src/runtime/engines/claude/lean.ts';
import { turnInput } from './fakes.ts';
import { claudeAccount, claudeSetup } from './claude-fixture.ts';

const input = (patch: Record<string, unknown> = {}) => turnInput({ model: 'claude-haiku-5-5', account: claudeAccount(), cwd: '/fake-temp/workforce', ...patch });

async function argsOf(patch: Record<string, unknown>): Promise<string[]> {
  const h = claudeSetup();
  const result = await h.engine.run(input(patch).input);
  assert.equal(result.stop, 'done');
  return h.cli.of('turn')[0].args;
}

test('claude: a turn with no tools, no MCP hub and no schema passes --tools followed by an empty list and keeps no transcript', async () => {
  const args = await argsOf({ tools: [] });
  const at = args.indexOf('--tools');
  assert.ok(at >= 0, '--tools is passed');
  assert.equal(args[at + 1], '', 'with an empty value: no built-in tools');
  assert.equal(args.filter((arg) => arg === '--tools').length, 1);
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(args.includes('--session-id'), 'the id the runtime picked still names the turn');
});

test('claude: a helper turn with an output schema has no built-in tool (--json-schema keeps its answer tool) and keeps no transcript', async () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  const args = await argsOf({ tools: [], outputSchema: schema });
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--json-schema') + 1], JSON.stringify(schema));
  assert.ok(args.includes('--no-session-persistence'));
});

test('claude: a hub turn keeps the built-in execution core (B-049 F2 – its own tools ask through the hub) and keeps its session', async () => {
  const args = await argsOf({ tools: [], mcp: { url: 'http://127.0.0.1:4555/mcp', token: 'hub-token-for-test' } });
  assert.deepEqual(args[args.indexOf('--tools') + 1].split(','), coreTools(), 'the core list, never an empty one');
  assert.equal(args.filter((arg) => arg === '--tools').length, 1);
  assert.equal(args.includes('--no-session-persistence'), false);
  assert.deepEqual(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2), ['--permission-mode', 'bypassPermissions'], 'Claude Code never asks');
});

test('claude: a turn without the hub that still names tools is an agent turn: the core list, its session kept', async () => {
  const args = await argsOf({});
  assert.deepEqual(args[args.indexOf('--tools') + 1].split(','), coreTools());
  assert.equal(args.filter((arg) => arg === '--tools').length, 1);
  assert.equal(args.includes('--no-session-persistence'), false);
});

test('claude: a turn stopped before its CLI starts starts none and makes no model call (as codex/turn.ts)', async () => {
  const h = claudeSetup();
  const stop = new AbortController();
  stop.abort();
  const result = await h.engine.run(input({ tools: [], signal: stop.signal }).input);
  assert.equal(result.stop, 'interrupted');
  assert.deepEqual(h.cli.of('turn'), [], 'no CLI process for the turn');
});
