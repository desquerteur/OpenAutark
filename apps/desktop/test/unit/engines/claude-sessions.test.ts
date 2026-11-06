// Claude Code engine sessions over a scripted `claude -p` stream: a new session carries the
// volatile context in the system prompt, a resumed one as a <workforce-context> block in the
// user message; the context window comes from result.modelUsage; a session id Claude Code no
// longer knows ends the session (details.rebase); a session this process ran in another folder is
// renewed quietly before the CLI starts (details.folder – Claude Code keeps sessions per folder).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeEngine, type FileOps } from '../../../src/runtime/engines/claude/engine.ts';
import { ClaudeStreamParser } from '../../../src/runtime/engines/claude/stream.ts';
import { fakeSpawn, fakeFinder, testSupervisor, turnInput, account } from './fakes.ts';

/** A scripted Claude Code process: answers the first user line with init + `result`. */
function claudeCli(result: (session: string) => Record<string, unknown>) {
  return fakeSpawn(({ args, child }) => {
    const at = args.indexOf('--resume') >= 0 ? args.indexOf('--resume') : args.indexOf('--session-id');
    const session = args[at + 1];
    child.onLine = (message) => {
      if (message?.type !== 'user') return;
      child.send({ type: 'system', subtype: 'init', session_id: session });
      child.send({ type: 'result', session_id: session, ...result(session) });
      setImmediate(() => child.exit(0));
    };
  });
}

function engine(spawn: ReturnType<typeof fakeSpawn>['spawn'], written: Map<string, string>) {
  const files: FileOps = {
    writeFile: async (file, data) => { written.set(file, data); },
    readFile: async () => new Uint8Array(),
    rm: async () => {},
    mkdir: async () => {},
  };
  let n = 0;
  return new ClaudeEngine({ supervisor: testSupervisor(spawn), finder: fakeFinder({ claude: '/bin/claude' }), tempDir: '/tmp/wf', files, uuid: () => `00000000-0000-4000-8000-00000000000${++n}` });
}

const userLine = (child: { lines: unknown[] }) => child.lines.find((line: any) => line?.type === 'user') as any;

test('claude: volatile context in the prompt of a new session, as a block on resume; the window from modelUsage', async () => {
  const ok = () => ({
    subtype: 'success', is_error: false, result: 'Done.', usage: { input_tokens: 10, output_tokens: 2 },
    modelUsage: { 'claude-haiku-5-5': { contextWindow: 200_000 }, 'claude-opus-5-5-20261001': { contextWindow: 1_000_000 } },
  });
  const cli = claudeCli(ok);
  const written = new Map<string, string>();
  const e = engine(cli.spawn, written);

  const fresh = await e.run(turnInput({ model: 'claude-opus-5-5', account: account({ provider: 'claude' }) }).input);
  assert.equal(fresh.stop, 'done');
  assert.equal(fresh.contextWindow, 1_000_000, 'the dated variant of the turn model, not the helper model');
  assert.ok(cli.calls[0].args.includes('--session-id'));
  assert.ok([...written.values()].some((text) => text === 'STABLE\n\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\n\nVOLATILE'), 'a new session gets both prompt parts (B-049: split at the boundary line)');
  assert.deepEqual(userLine(cli.calls[0].child).message.content, [{ type: 'text', text: 'hello' }]);

  const resumed = await e.run(turnInput({ model: 'claude-opus-5-5', session: fresh.session, system: { stable: 'STABLE', volatile: 'VOLATILE2' } }).input);
  assert.equal(resumed.stop, 'done');
  assert.deepEqual(resumed.session, fresh.session);
  const args = cli.calls[1].args;
  assert.equal(args[args.indexOf('--resume') + 1], fresh.session!.ref);
  const content = userLine(cli.calls[1].child).message.content;
  assert.deepEqual(content[0], { type: 'text', text: '<workforce-context>\nVOLATILE2\n</workforce-context>' });
  assert.deepEqual(content[1], { type: 'text', text: 'hello' });
  await e.dispose();

  const parser = new ClaudeStreamParser(() => {}, () => 0);
  parser.push({ type: 'result', subtype: 'success', modelUsage: { 'claude-sonnet-5-5[1m]': { contextWindow: 1_000_000 } } });
  assert.equal(parser.contextWindow('claude-sonnet-5-5'), 1_000_000);
  assert.equal(parser.contextWindow('claude-opus-5-5'), 1_000_000, 'the only model reported');
});

test('claude: a session id Claude Code no longer knows ends the session; other errors do not', async () => {
  const cli = claudeCli((session) => ({ subtype: 'error_during_execution', is_error: true, result: `No conversation found with session ID: ${session}` }));
  const e = engine(cli.spawn, new Map());
  const gone = await e.run(turnInput({ session: { ref: 'b6f1c2d4-0000-4000-8000-000000000000', generation: 2 } }).input);
  assert.equal(gone.stop, 'error');
  assert.equal(gone.error?.code, 'conflict');
  assert.equal(gone.error?.details?.rebase, true);
  assert.equal(gone.session, undefined);

  const failing = claudeCli(() => ({ subtype: 'error_during_execution', is_error: true, result: 'Something else went wrong' }));
  const e2 = engine(failing.spawn, new Map());
  const failed = await e2.run(turnInput({ session: { ref: 'b6f1c2d4-0000-4000-8000-000000000000', generation: 2 } }).input);
  assert.equal(failed.stop, 'error');
  assert.equal(failed.error?.details?.rebase, undefined);
  await e.dispose();
  await e2.dispose();
});

test('claude: the live 2.1.303 answer to an unknown --resume (only `errors`, no init, exit 1) ends the session', async () => {
  // Recorded 23.10. from claude.exe 2.1.303: the only stdout line, then exit code 1.
  const { spawn } = fakeSpawn(({ args, child }) => {
    const session = args[args.indexOf('--resume') + 1];
    child.onLine = (message) => {
      if (message?.type !== 'user') return;
      child.send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [`No conversation found with session ID: ${session}`] });
      setImmediate(() => child.exit(1));
    };
  });
  const e = engine(spawn, new Map());
  const gone = await e.run(turnInput({ session: { ref: '3f0b8f4e-1a2b-4c3d-9e8f-0123456789ab', generation: 3 } }).input);
  assert.equal(gone.stop, 'error');
  assert.deepEqual([gone.error?.code, gone.error?.details?.rebase], ['conflict', true], 'renewed by the executor instead of failing every later turn');
  assert.equal(gone.session, undefined);
  await e.dispose();

  const parser = new ClaudeStreamParser(() => {}, () => 0);
  parser.push({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Usage limit reached · resets 3pm', 42] });
  assert.equal(parser.state.errorText, 'Usage limit reached · resets 3pm', 'only the strings of `errors`');
  assert.equal(parser.limited(), true, 'an error text in `errors` is read for limits too');
});

test('claude: a session this process ran in another folder is renewed quietly before the CLI starts; the same folder resumes', async () => {
  const cli = claudeCli(() => ({ subtype: 'success', is_error: false, result: 'Done.' }));
  const e = engine(cli.spawn, new Map());
  const first = await e.run(turnInput({ cwd: '/work' }).input);
  assert.equal(first.stop, 'done');
  const again = await e.run(turnInput({ cwd: '/work/', session: first.session }).input);
  assert.equal(again.stop, 'done', 'the same folder (another spelling) resumes');
  const moved = await e.run(turnInput({ cwd: '/work/.worktrees/site-1a2b3c/fix', session: first.session }).input);
  assert.equal(moved.stop, 'error');
  assert.deepEqual(moved.error?.details, { rebase: true, folder: true });
  assert.equal(cli.calls.length, 2, 'no CLI start for the moved session');
  const unknown = await e.run(turnInput({ cwd: '/elsewhere', session: { ref: 'b6f1c2d4-0000-4000-8000-000000000000', generation: 2 } }).input);
  assert.equal(unknown.stop, 'done', 'a session from before this process is resumed as before');
  await e.dispose();
});
