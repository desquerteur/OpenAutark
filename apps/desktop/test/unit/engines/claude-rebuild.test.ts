// B-048 E2 (TRANSFER) – Claude Code native rebuild over a scripted CLI and in-memory files: the transcript format
// (uuid/parentUuid chain, sessionId, cwd, version; hub tools as tool_use/tool_result with mcp__workforce__* names;
// native calls mapped by neutral-calls.ts (B-049), everything else as text; thinking only signed and from the same source; a clean turn boundary; no api-request
// records), path resume args and the session ref after the turn, a refused first turn (rebuild 'failed'), the
// project tier (own homes only), the model-free probe and its tiers, deleting superseded sessions, the thinking
// display flag and signature capture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { ClaudeEngine } from '../../../src/runtime/engines/claude/engine.ts';
import { ClaudeStreamParser } from '../../../src/runtime/engines/claude/stream.ts';
import { END_MARK, claudeTranscript } from '../../../src/runtime/engines/claude/transcript.ts';
import { PROJECT_DIR_NAME, probeOutcome } from '../../../src/runtime/engines/claude/rebuild.ts';
import { takesThinkingDisplay } from '../../../src/runtime/engines/claude/rebuilder.ts';
import type { EngineEvent, RebuildItem } from '../../../src/runtime/engines/types.ts';
import { account, fakeFinder, fakeSpawn, testSupervisor, turnInput, type SpawnCall } from './fakes.ts';

const DATA = path.resolve('/fake-data');
const TRANSCRIPTS = path.join(DATA, 'engine-transcripts', 'claude');
const ACCOUNTS = path.join(DATA, 'accounts');
const OWN_HOME = path.join(ACCOUNTS, 'acc_claude');

/** In-memory files with sizes and folder listings. */
function memoryFs() {
  const files = new Map<string, string>();
  const removed: string[] = [];
  const ops = {
    writeFile: async (file: string, data: string) => { files.set(path.resolve(file), data); },
    readFile: async (file: string) => { const text = files.get(path.resolve(file)); if (text === undefined) throw new Error('missing'); return new TextEncoder().encode(text); },
    rm: async (file: string) => { removed.push(path.resolve(file)); files.delete(path.resolve(file)); },
    mkdir: async () => {},
    rmDir: async (dir: string) => { removed.push(`${path.resolve(dir)}/`); },
    size: async (file: string) => files.get(path.resolve(file))?.length,
    folders: async (dir: string) => [...new Set([...files.keys()].filter((file) => path.dirname(path.dirname(file)) === path.resolve(dir)).map((file) => path.basename(path.dirname(file))))],
  };
  return { files, removed, ops };
}

interface CliScript {
  version?: string;
  /** Lines of a turn after its user message (default: success). `session` is the id the CLI reports. */
  turn?: (call: SpawnCall, fs: ReturnType<typeof memoryFs>) => unknown[];
  /** The probe process' answer per --resume target: 'ok' answers initialize, else an error result. */
  probe?: (target: string, call: SpawnCall) => 'ok' | string;
}

const valueAfter = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

function setup(script: CliScript = {}) {
  const fs = memoryFs();
  let n = 0;
  const fake = fakeSpawn((call) => {
    const { child, args } = call;
    if (args.includes('--version')) { setImmediate(() => { child.stdout.write(`${script.version ?? '2.1.303'} (Claude Code)\n`); setImmediate(() => child.exit(0)); }); return; }
    if (!args.includes('--include-partial-messages')) { // the rebuild probe: initialize only, never a user message
      child.onLine = (message) => {
        if (message?.type !== 'control_request') return;
        const answer = script.probe?.(valueAfter(args, '--resume') ?? '', call) ?? 'ok';
        if (answer === 'ok') child.send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { commands: [] } } });
        else { child.send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [answer] }); setImmediate(() => child.exit(1)); }
      };
      return;
    }
    let started = false;
    child.onLine = (message) => {
      if (message?.type !== 'user' || started) return;
      started = true;
      const resume = valueAfter(args, '--resume') ?? valueAfter(args, '--session-id') ?? '';
      const session = resume.endsWith('.jsonl') ? path.basename(resume, '.jsonl') : resume;
      child.send({ type: 'system', subtype: 'init', session_id: session, claude_code_version: script.version ?? '2.1.303' });
      for (const line of script.turn?.(call, fs) ?? [{ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: session }]) child.send(line);
      setImmediate(() => child.exit(0));
    };
  });
  const engine = new ClaudeEngine({
    supervisor: testSupervisor(fake.spawn), finder: fakeFinder({ claude: '/fake-bin/claude' }), tempDir: '/fake-temp', files: fs.ops,
    env: { PATH: '/fake-bin' }, now: () => 1_800_000_000_000, uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    transcriptsDir: TRANSCRIPTS, accountsRoot: ACCOUNTS,
  });
  return { engine, fs, calls: fake.calls, turns: () => fake.calls.filter((call) => call.args.includes('--include-partial-messages')) };
}

const claudeAccount = (patch: Record<string, unknown> = {}) => account({ id: 'acc_claude', provider: 'claude', home: OWN_HOME, ...patch });
const offered = new Set(['tasks.create']);
const ITEMS: RebuildItem[] = [
  { itemId: 'a1', kind: 'a', role: 'assistant', text: 'Earlier I started the export.' },
  { itemId: 'm3', kind: 'm', role: 'user', text: '[10:00] Lena: go on' },
  { itemId: 'r4', kind: 'r', role: 'assistant', text: 'Signed thought.', origin: { engine: 'claude', model: 'claude:claude-opus-5-5', accountId: 'acc_claude' }, reasoning: { signature: 'SIG' } },
  { itemId: 't5', kind: 't', role: 'tool', text: '', call: { name: 'tasks.create', args: { title: 'Export' }, callId: 'call_9', output: 'created tsk_1' }, origin: { engine: 'codex' } },
  { itemId: 't6', kind: 't', role: 'tool', text: '', call: { own: true, name: 'shell', args: { command: 'npm test' }, callId: 'c1', output: '12 passing' }, origin: { engine: 'codex' } },
  { itemId: 'r7', kind: 'r', role: 'assistant', text: 'Codex summary of thinking.', origin: { engine: 'codex', model: 'codex:gpt-6.1-sol' } },
  { itemId: 'a8', kind: 'a', role: 'assistant', text: 'Tests pass.\n{"compacted":"a8","was":"400 tokens","restore":"context.restore"}' },
];

test('claude transcript: the record chain, hub calls 1:1, a Codex shell call as Bash, signed thinking only from the same source', () => {
  let n = 0;
  const { lines, records } = claudeTranscript(ITEMS, {
    sessionId: 'sess-1', cwd: '/work', version: '2.1.303', model: 'claude-opus-5-5', accountId: 'acc_claude', offered, uuid: () => `u${++n}`, now: 0,
  });
  const recs = lines.map((line) => JSON.parse(line));
  assert.equal(records, recs.length);
  assert.deepEqual(recs.map((rec) => rec.type), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  recs.forEach((rec, i) => {
    assert.equal(rec.uuid, `u${i + 1}`);
    assert.equal(rec.parentUuid, i ? `u${i}` : null);
    assert.equal(rec.sessionId, 'sess-1');
    assert.equal(rec.cwd, '/work');
    assert.equal(rec.version, '2.1.303');
    assert.equal(rec.isSidechain, false);
  });
  assert.ok(recs.every((rec) => !String(rec.type).startsWith('api-request')), 'no api-request records');
  assert.equal(recs[0].message.content, '[Earlier work in this chat, rebuilt by the app]', 'the transcript starts with a user record');
  assert.equal(recs[2].message.content, '[10:00] Lena: go on');
  // Signed Claude thinking of the same account and family stays a thinking block, in front of the hub call.
  assert.deepEqual(recs[3].message.content, [
    { type: 'thinking', thinking: 'Signed thought.', signature: 'SIG' },
    { type: 'tool_use', id: 'call_9', name: 'mcp__workforce__tasks__create', input: { title: 'Export' } },
  ]);
  assert.equal(recs[3].message.stop_reason, 'tool_use');
  assert.deepEqual(recs[4].message.content, [{ type: 'tool_result', tool_use_id: 'call_9', content: 'created tsk_1' }]);
  assert.equal(recs[4].sourceToolAssistantUUID, 'u4');
  // B-049 neutral mapping: Codex's native shell is Claude Code's own Bash with its real output as the tool_result.
  assert.deepEqual(recs[5].message.content, [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'npm test' } }]);
  assert.equal(recs[5].message.stop_reason, 'tool_use');
  assert.deepEqual(recs[6].message.content, [{ type: 'tool_result', tool_use_id: 'c1', content: '12 passing' }]);
  assert.equal(recs[6].sourceToolAssistantUUID, 'u6');
  // Codex reasoning cannot replay here: it leaves nothing (no text the model never said); the condensed stamp stays verbatim.
  assert.deepEqual(recs[7].message.content, [
    { type: 'text', text: 'Tests pass.\n{"compacted":"a8","was":"400 tokens","restore":"context.restore"}' },
  ]);
  assert.equal(recs[7].message.stop_reason, 'end_turn');

  // Unsigned, foreign or trailing thinking never becomes a thinking block.
  const tail = claudeTranscript([
    { itemId: 'm1', kind: 'm', role: 'user', text: 'hi' },
    { itemId: 'r2', kind: 'r', role: 'assistant', text: 'Unsigned.', origin: { engine: 'claude', model: 'claude:claude-opus-5-5', accountId: 'acc_claude' } },
    { itemId: 'r3', kind: 'r', role: 'assistant', text: 'Signed but last.', origin: { engine: 'claude', model: 'claude:claude-opus-5-5', accountId: 'acc_claude' }, reasoning: { signature: 'S' } },
  ], { sessionId: 's', cwd: '/w', version: 'v', model: 'claude-opus-5-5', accountId: 'acc_claude', offered, uuid: () => 'u', now: 0 });
  assert.ok(!tail.lines.join('\n').includes('thinking'), tail.lines.join('\n'));
});

test('claude transcript: one of our tools the turn does not offer stands as the tools.call it was; an offered one under its own name', () => {
  const items: RebuildItem[] = [
    { itemId: 't1', kind: 't', role: 'tool', text: '', call: { name: 'context.restore', args: { ids: ['t1'] }, callId: 'mcp-1', output: 'Restored t1' } },
    { itemId: 't2', kind: 't', role: 'tool', text: '', call: { name: 'tasks.create', args: { title: 'x' }, callId: 'mcp-2', output: 'ok' } },
  ];
  const lines = (names: string[]) => claudeTranscript(items, { sessionId: 's', cwd: '/w', version: 'v', model: 'claude-opus-5-5', accountId: 'acc_claude', offered: new Set(names), uuid: () => 'u', now: 0 }).lines.map((line) => JSON.parse(line));
  const uses = (names: string[]) => lines(names).flatMap((rec) => (Array.isArray(rec.message.content) ? rec.message.content : [])).filter((part) => part.type === 'tool_use').map((part) => [part.name, part.input]);
  assert.deepEqual(uses(['tasks.create', 'tools.call']), [
    ['mcp__workforce__tools__call', { name: 'context.restore', args: { ids: ['t1'] } }],
    ['mcp__workforce__tasks__create', { title: 'x' }],
  ]);
  assert.deepEqual(uses([]).map(([name]) => name), ['mcp__workforce__context__restore', 'mcp__workforce__tasks__create'], 'the calls shown to a session as they are (no offer known)');
});

test('claude transcript (B-049 neutral mapping): a Codex PowerShell line → PowerShell on Windows, Claude\'s own Read verbatim, a Codex patch stays a note', () => {
  const items: RebuildItem[] = [
    { itemId: 'm1', kind: 'm', role: 'user', text: 'go' },
    { itemId: 't2', kind: 't', role: 'tool', text: '', call: { own: true, name: 'shell', args: { command: '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command \'Get-ChildItem\'' }, callId: 'exec-1', output: 'a.ts' }, origin: { engine: 'codex' } },
    { itemId: 't3', kind: 't', role: 'tool', text: '', call: { own: true, name: 'Read', args: { file_path: 'C:\\w\\a.ts', offset: 5 }, callId: 'toolu_r', output: '5\tconst a = 1;' }, origin: { engine: 'claude' } },
    { itemId: 't4', kind: 't', role: 'tool', text: '', call: { own: true, name: 'apply_patch', args: { files: ['a.ts'] }, callId: 'patch-1', output: 'update a.ts\n-1\n+2' }, origin: { engine: 'codex' } },
  ];
  const context = { sessionId: 's', cwd: '/w', version: 'v', model: 'claude-opus-5-5', accountId: 'acc_claude', offered, uuid: () => 'u', now: 0 };
  const recs = claudeTranscript(items, { ...context, platform: 'win32' }).lines.map((line) => JSON.parse(line));
  assert.deepEqual(recs.map((rec) => rec.type), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(recs[1].message.content, [{ type: 'tool_use', id: 'exec-1', name: 'PowerShell', input: { command: 'Get-ChildItem' } }]);
  assert.deepEqual(recs[2].message.content, [{ type: 'tool_result', tool_use_id: 'exec-1', content: 'a.ts' }]);
  assert.deepEqual(recs[3].message.content, [{ type: 'tool_use', id: 'toolu_r', name: 'Read', input: { file_path: 'C:\\w\\a.ts', offset: 5 } }]);
  assert.deepEqual(recs[5].message.content, [{ type: 'text', text: '[ran apply_patch: a.ts]' }]);
  assert.equal(recs[6].message.content, '[output of apply_patch]\nupdate a.ts\n-1\n+2');
  assert.deepEqual(recs[7].message.content, [{ type: 'text', text: END_MARK }]);
  const linux = claudeTranscript(items.slice(0, 2), { ...context, platform: 'linux' }).lines.map((line) => JSON.parse(line));
  assert.equal(linux[1].message.content[0].name, 'Bash', 'no PowerShell tool off Windows: the whole line from Bash');
});

test('claude rebuild: the transcript lands in the app data folder; the next turn resumes it by absolute path; the ref follows the file that grew', async () => {
  const h = setup({
    turn: (call, fs) => {
      const file = valueAfter(call.args, '--resume')!;
      if (file.endsWith('.jsonl')) fs.files.set(path.resolve(file), `${fs.files.get(path.resolve(file))}{"appended":true}\n`); // the CLI appends to the loaded file
      return [{ type: 'result', subtype: 'success', is_error: false, result: 'Continued.', session_id: path.basename(file, '.jsonl') }];
    },
  });
  const { input } = turnInput({ account: claudeAccount(), model: 'claude-opus-5-5' });
  const built = await h.engine.rebuild({
    runId: 'run_1', agentId: 'ag_1', account: claudeAccount(), model: 'claude-opus-5-5', cwd: '/work', items: ITEMS, tools: [], toolNames: ['tasks.create'],
    system: { stable: 'STABLE', volatile: 'VOLATILE' }, generation: 2, probe: { version: '2.1.303', ok: true, tier: 'path', at: 1 },
  });
  assert.equal(built.ref, path.join(TRANSCRIPTS, '00000000-0000-4000-8000-000000000001.jsonl'));
  assert.ok(path.isAbsolute(built.ref));
  assert.equal(built.generation, 2);
  const written = h.fs.files.get(path.resolve(built.ref))!.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(written.every((rec) => rec.sessionId === '00000000-0000-4000-8000-000000000001' && rec.version === '2.1.303'), 'the version came from claude --version');

  const result = await h.engine.run({ ...input, session: { ref: built.ref, generation: 2 } });
  const args = h.turns()[0].args;
  assert.equal(valueAfter(args, '--resume'), built.ref);
  assert.equal(args.includes('--session-id'), false);
  assert.equal(result.stop, 'done');
  assert.equal(result.session?.ref, built.ref, 'the CLI appended to our transcript: the path stays the ref');

  // When the CLI writes its own transcript instead, the reported session id is the ref.
  const other = setup();
  const again = await other.engine.rebuild({
    runId: 'run_2', agentId: 'ag_1', account: claudeAccount(), model: 'claude-opus-5-5', cwd: '/work', items: ITEMS, tools: [], toolNames: [], system: { stable: 'S', volatile: 'V' }, generation: 1,
  });
  const next = await other.engine.run({ ...turnInput({ account: claudeAccount(), model: 'claude-opus-5-5' }).input, session: { ref: again.ref, generation: 1 } });
  assert.equal(next.session?.ref, '00000000-0000-4000-8000-000000000001');

  // B-048 review: the moved ref is the same session – the superseded path ref (sessions.ts records it) deletes only
  // our transcript, never the CLI's own transcript the bound id now resumes.
  const live = path.join(OWN_HOME, 'projects', 'C--work', '00000000-0000-4000-8000-000000000001.jsonl');
  other.fs.files.set(path.resolve(live), '{"live":true}\n');
  assert.equal(await other.engine.deleteSession(claudeAccount(), again.ref), 'deleted');
  assert.ok(!other.fs.files.has(path.resolve(again.ref)), 'our transcript goes');
  assert.ok(other.fs.files.has(path.resolve(live)), 'the live session stays');
});

test('claude transcript: a history that ends on the user side closes with the app\'s labelled record (no interrupted turn on resume)', () => {
  const context = { sessionId: 's', cwd: '/w', version: 'v', model: 'claude-opus-5-5', accountId: 'acc_claude', offered, uuid: () => 'u', now: 0 };
  const call = { name: 'tasks.create', args: {}, callId: 'c1', output: 'created tsk_1' };
  const endsWithCall = claudeTranscript([{ itemId: 'm1', kind: 'm', role: 'user', text: 'hi' }, { itemId: 't2', kind: 't', role: 'tool', text: '', call }], context);
  const recs = endsWithCall.lines.map((line) => JSON.parse(line));
  assert.deepEqual(recs.map((rec) => rec.type), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(recs[2].message.content[0].type, 'tool_result');
  assert.deepEqual(recs[3].message.content, [{ type: 'text', text: END_MARK }]);
  assert.equal(recs[3].message.stop_reason, 'end_turn');
  const native = claudeTranscript([{ itemId: 't1', kind: 't', role: 'tool', text: '', call: { ...call, name: 'shell' } }], context).lines.map((line) => JSON.parse(line));
  assert.equal(native.at(-1).type, 'assistant', 'a native call\'s output note is not the last record either');
  const answered = claudeTranscript([{ itemId: 'm1', kind: 'm', role: 'user', text: 'hi' }, { itemId: 'a2', kind: 'a', role: 'assistant', text: 'Done.' }], context).lines.map((line) => JSON.parse(line));
  assert.deepEqual(answered.at(-1).message.content, [{ type: 'text', text: 'Done.' }], 'the agent\'s own answer closes it: no extra record');
});

test('claude rebuild: a refused first turn on a rebuilt session reports it ended (rebuild failed); a refused later turn is a plain failure', async () => {
  const h = setup({ turn: () => [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['API Error: 400 messages.3: invalid'] }] });
  const base = { runId: 'run_1', agentId: 'ag_1', account: claudeAccount(), model: 'claude-opus-5-5', cwd: '/work', items: ITEMS, tools: [], toolNames: ['tasks.create'], system: { stable: 'S', volatile: 'V' }, generation: 1 };
  const built = await h.engine.rebuild(base);
  const input = { ...turnInput({ account: claudeAccount(), model: 'claude-opus-5-5' }).input, session: { ref: built.ref, generation: 1 } };
  const first = await h.engine.run(input);
  assert.equal(first.stop, 'error');
  assert.deepEqual({ rebase: first.error?.details?.rebase, rebuild: first.error?.details?.rebuild }, { rebase: true, rebuild: 'failed' });
  assert.equal(first.session, undefined);
  const later = await h.engine.run(input);
  assert.equal(later.error?.code, 'internal', 'only the first turn falls back');
  assert.equal(later.session?.ref, built.ref, 'a failed turn keeps the transcript path as the ref');
});

test('claude rebuild: the project tier writes into the own home\'s fixed folder and resumes by id with CLAUDE_CODE_PROJECT_DIR_NAME; never into another home', async () => {
  const h = setup();
  const base = { runId: 'run_1', agentId: 'ag_1', model: 'claude-opus-5-5', cwd: '/work', items: ITEMS, tools: [], toolNames: [], system: { stable: 'S', volatile: 'V' }, generation: 1, probe: { version: '2.1.303', ok: true, tier: 'project' as const, at: 1 } };
  const built = await h.engine.rebuild({ ...base, account: claudeAccount() });
  assert.equal(built.ref, 'project:00000000-0000-4000-8000-000000000001');
  assert.ok(h.fs.files.has(path.join(OWN_HOME, 'projects', PROJECT_DIR_NAME, '00000000-0000-4000-8000-000000000001.jsonl')));
  const result = await h.engine.run({ ...turnInput({ account: claudeAccount(), model: 'claude-opus-5-5' }).input, session: { ref: built.ref, generation: 1 } });
  const call = h.turns()[0];
  assert.equal(valueAfter(call.args, '--resume'), '00000000-0000-4000-8000-000000000001');
  assert.equal(call.options.env?.CLAUDE_CODE_PROJECT_DIR_NAME, PROJECT_DIR_NAME);
  assert.equal(result.session?.ref, 'project:00000000-0000-4000-8000-000000000001');

  await assert.rejects(h.engine.rebuild({ ...base, account: claudeAccount({ home: '/home/person/.claude', detected: true }) }), /app-owned Claude home/);
});

test('claude rebuild probe: initialize answered after --resume <path> passes; a refused path tier tries the own home\'s project folder; files are cleaned up', async () => {
  const ok = setup();
  const probe = await ok.engine.probeRebuild(claudeAccount(), '/work');
  assert.deepEqual({ ...probe, at: 0 }, { version: '2.1.303', ok: true, tier: 'path', at: 0 });
  const call = ok.calls.find((entry) => entry.args.includes('--resume'))!;
  assert.ok(valueAfter(call.args, '--resume')!.startsWith(TRANSCRIPTS));
  assert.ok(!call.args.includes('--include-partial-messages') && call.args.includes('--tools'), 'a bare process: no turn, no tools');
  assert.equal(ok.fs.files.size, 0, 'the probe transcript is deleted');
  assert.ok(call.child.stdin.writableEnded && !call.child.killed, 'login guard 03.11.: answered, its input is closed and it is not killed (it ends by itself)');

  const project = setup({ probe: (target) => (target.endsWith('.jsonl') ? 'No conversation found with session ID: x' : 'ok') });
  const second = await project.engine.probeRebuild(claudeAccount(), '/work');
  assert.equal(second.ok, true);
  assert.equal(second.tier, 'project');
  assert.match(second.reason ?? '', /path resume: No conversation found/);
  const projectCall = project.calls.filter((entry) => entry.args.includes('--resume')).at(-1)!;
  assert.equal(projectCall.options.env?.CLAUDE_CODE_PROJECT_DIR_NAME, PROJECT_DIR_NAME);
  assert.equal(project.fs.files.size, 0);

  const foreign = setup({ probe: () => 'No conversation found' });
  const refused = await foreign.engine.probeRebuild(claudeAccount({ home: '/home/person/.claude' }), '/work');
  assert.equal(refused.ok, false);
  assert.equal(foreign.calls.filter((entry) => entry.args.includes('--resume')).length, 1, 'no project tier outside the app\'s own homes');
  assert.deepEqual(probeOutcome(''), { ok: false, reason: 'the resumed session did not start' });
});

test('claude deleteSession: our transcript and the CLI\'s transcript of that session id – nothing outside, nothing not named by a session id', async () => {
  const h = setup();
  const id = '11111111-2222-4333-8444-555555555555';
  const ours = path.join(TRANSCRIPTS, `${id}.jsonl`);
  const cli = path.join(OWN_HOME, 'projects', 'C--work', `${id}.jsonl`);
  const unrelated = path.join(OWN_HOME, 'projects', 'C--work', '99999999-2222-4333-8444-555555555555.jsonl');
  for (const file of [ours, cli, unrelated]) h.fs.files.set(path.resolve(file), '{}\n');
  assert.equal(await h.engine.deleteSession(claudeAccount(), ours), 'deleted');
  assert.ok(!h.fs.files.has(path.resolve(ours)));
  assert.ok(h.fs.files.has(path.resolve(cli)), 'a path ref deletes our transcript only: the CLI\'s transcript of that id may be the session the ref moved to');
  assert.equal(await h.engine.deleteSession(claudeAccount(), ours), 'missing');
  // A plain session id: found by listing folder names.
  assert.equal(await h.engine.deleteSession(claudeAccount(), id), 'deleted');
  assert.ok(!h.fs.files.has(path.resolve(cli)));
  assert.ok(h.fs.files.has(path.resolve(unrelated)), 'other sessions stay');
  assert.ok(h.fs.removed.includes(`${path.resolve(path.join(OWN_HOME, 'projects', 'C--work', id))}/`), 'the session\'s own folder goes too');
  // Never outside the app's folder, never a name that is no session id.
  const outside = path.resolve('/elsewhere', `${id}.jsonl`);
  h.fs.files.set(outside, '{}\n');
  assert.equal(await h.engine.deleteSession(claudeAccount({ home: undefined }), outside), 'missing');
  assert.ok(h.fs.files.has(outside));
  assert.equal(await h.engine.deleteSession(claudeAccount(), '../../etc/passwd'), 'missing');
});

test('claude thinking: agent turns ask for summarized thinking once the CLI version (system/init) is known to take the flag; signatures ride on reasoning_end', async () => {
  const h = setup();
  const agent = () => turnInput({ account: claudeAccount(), model: 'claude-opus-5-5' }).input;
  await h.engine.run(agent());
  assert.equal(h.turns()[0].args.includes('--thinking-display'), false, 'unknown version: no flag');
  await h.engine.run(agent());
  assert.equal(valueAfter(h.turns()[1].args, '--thinking-display'), 'summarized');
  await h.engine.run({ ...agent(), tools: [], mcp: undefined });
  assert.equal(h.turns()[2].args.includes('--thinking-display'), false, 'a helper turn never asks');
  assert.equal(takesThinkingDisplay('2.1.302'), false);
  assert.equal(takesThinkingDisplay('2.2.0'), true);

  const events: EngineEvent[] = [];
  const parser = new ClaudeStreamParser((event) => events.push(event), () => 0);
  parser.push({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } });
  parser.push({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } });
  parser.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan A.' } } });
  parser.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'AB' } } });
  parser.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'CD' } } });
  parser.push({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  assert.deepEqual(events, [{ type: 'reasoning', delta: 'Plan A.', id: 'msg_1:0' }, { type: 'reasoning_end', id: 'msg_1:0', signature: 'ABCD' }]);
});
