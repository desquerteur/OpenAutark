// Owns: adaptive shell deadlines, cancellation races and process-tree termination. Never: runs an install or contacts a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { runCommand } from '../../../src/runtime/tools/builtin/command.ts';
import { defaultShell, type ShellSpawn } from '../../../src/runtime/tools/builtin/files.ts';
import { initialTimeoutSeconds, reviewToolTimeout, TIMEOUT_REVIEW_MS, type ToolTimeoutDecision } from '../../../src/runtime/tools/timeout.ts';
import { chooseToolTimeout } from '../../../src/runtime/subconscious/tool-timeout.ts';
import type { RuntimeServices, DecisionRequest } from '../../../src/runtime/contracts.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(review?: RuntimeServices['subconscious']['toolTimeout']) {
  const stop = new AbortController();
  const stdout = new EventEmitter();
  const child = Object.assign(new EventEmitter(), { stdout, stderr: null, kill: () => true });
  let spawned = 0;
  let commandSignal: AbortSignal | undefined;
  const notes: unknown[] = [];
  const shell: ShellSpawn = (_command, options) => { spawned++; commandSignal = options.signal; return child as unknown as ReturnType<ShellSpawn>; };
  const ctx = {
    agent: { id: 'ag_a', name: 'Ada' }, runId: 'r1', mode: 'coding', signal: stop.signal, status() {},
    services: { secrets: { redact: (text: string) => text.replaceAll('sensitive-value', 'secret://s1') }, subconscious: { toolTimeout: review }, runs: { item: (_id: string, item: unknown) => notes.push(item) } },
  } as unknown as ToolContext;
  return { shell, ctx, child, stdout, stop, notes, spawned: () => spawned, commandSignal: () => commandSignal };
}

test('initial estimates distinguish actual commands and explicit review intervals', () => {
  assert.equal(initialTimeoutSeconds('shell', { command: 'npm install' }), 300);
  assert.equal(initialTimeoutSeconds('shell', { command: 'npm ci' }), 300);
  assert.equal(initialTimeoutSeconds('shell', 'npm install'), 300);
  assert.equal(initialTimeoutSeconds('shell', { command: 'python -m pip install requests' }), 300);
  assert.equal(initialTimeoutSeconds('shell', { command: 'git clone https://example.com/repo' }), 300);
  assert.equal(initialTimeoutSeconds('shell', { command: 'npm run test' }), 180);
  assert.equal(initialTimeoutSeconds('shell', { command: 'rg install src' }), 15);
  assert.equal(initialTimeoutSeconds('shell', { command: 'rg "npm install" src' }), 15);
  assert.equal(initialTimeoutSeconds('Grep', { pattern: 'npm install' }), 15);
  assert.equal(initialTimeoutSeconds('shell', { command: 'something', timeoutSeconds: 27 }), 27);
  assert.equal(initialTimeoutSeconds('shell', { command: ['npm', 'install'] }), 300);
});

test('wait twice then abort: one process, chosen deadlines, partial output and decisions reach main AI', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const seen: unknown[] = [];
  const replies: ToolTimeoutDecision[] = [{ action: 'wait', seconds: 2, reason: 'Still working' }, { action: 'wait', seconds: 3, reason: 'Almost done' }, { action: 'abort', reason: 'No progress' }];
  const f = fixture(async (input) => { seen.push(input); return replies.shift()!; });
  const pending = runCommand(f.shell, f.ctx, { command: 'slow', cwd: '.', timeoutSeconds: 1 });
  await flush();
  f.stdout.emit('data', 'partial sensitive-value');
  t.mock.timers.tick(1000); await flush();
  assert.equal(f.commandSignal()?.aborted, false);
  t.mock.timers.tick(1999); await flush(); assert.equal(seen.length, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(seen.length, 2);
  t.mock.timers.tick(3000); await flush();
  const result = await pending;
  const text = result.content[0].type === 'text' ? result.content[0].text : '';
  assert.equal(f.spawned(), 1);
  assert.equal(f.commandSignal()?.aborted, true);
  assert.equal(result.isError, true);
  assert.match(text, /wait another 2 seconds[\s\S]*wait another 3 seconds[\s\S]*abort the running call[\s\S]*exit timeout[\s\S]*partial secret:\/\/s1/);
  assert.equal(JSON.stringify(seen).includes('sensitive-value'), false);
  assert.equal(f.notes.length, 3);
});

test('reviews see recent output after the result output cap has filled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let output = '';
  const f = fixture(async (input) => { output = input.output; return { action: 'abort', reason: 'Done checking' }; });
  const pending = runCommand(f.shell, f.ctx, { command: 'slow', cwd: '.', timeoutSeconds: 1 });
  await flush();
  f.stdout.emit('data', 'old '.repeat(40_000));
  f.stdout.emit('data', 'new progress sensitive-value');
  t.mock.timers.tick(1000); await flush();
  await pending;
  assert.match(output, /new progress secret:\/\/s1$/);
  assert.equal(output.includes('sensitive-value'), false);
});

test('a command finishing while review waits cancels review and ignores its late abort', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let answer!: (value: ToolTimeoutDecision) => void;
  let reviewSignal: AbortSignal | undefined;
  const f = fixture((input) => { reviewSignal = input.signal; return new Promise((resolve) => { answer = resolve; }); });
  const pending = runCommand(f.shell, f.ctx, { command: 'slow', cwd: '.', timeoutSeconds: 1 });
  await flush(); t.mock.timers.tick(1000); await flush();
  f.stdout.emit('data', 'done'); f.child.emit('close', 0);
  const result = await pending;
  answer({ action: 'abort', reason: 'Late answer' }); await flush();
  assert.equal(reviewSignal?.aborted, true);
  assert.equal(result.isError, false);
  assert.equal(f.commandSignal()?.aborted, false);
  assert.equal(f.notes.length, 0);
});

test('parent abort releases a command even when its fake process and review ignore cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(() => new Promise(() => {}));
  const pending = runCommand(f.shell, f.ctx, { command: 'slow', cwd: '.', timeoutSeconds: 1 });
  await flush(); t.mock.timers.tick(1000); await flush(); f.stop.abort();
  assert.equal((await pending).isError, true);
  assert.equal(f.commandSignal()?.aborted, true);
  const stopped = await runCommand(f.shell, f.ctx, { command: 'never', cwd: '.' });
  assert.equal(stopped.isError, true); assert.equal(f.spawned(), 1);
});

test('a stuck subconscious review has its own deadline and returns abort', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(() => new Promise(() => {}));
  const pending = reviewToolTimeout(f.ctx, { tool: 'shell', args: {}, elapsedSeconds: 15, timeoutSeconds: 15, output: '' });
  await flush(); t.mock.timers.tick(TIMEOUT_REVIEW_MS); await flush();
  assert.equal((await pending).action, 'abort');
});

test('choice-only decision model receives timeout as tool output and chooses seconds', async () => {
  const requests: DecisionRequest[] = [];
  const services = { decisions: { decide: async (request: DecisionRequest) => { requests.push(request); return { choice: 'Wait 120 seconds', confidence: 0.95, by: 'systemone' }; } } } as unknown as RuntimeServices;
  const result = await chooseToolTimeout(services, { tool: 'shell', args: { command: 'npm install' }, elapsedSeconds: 300, timeoutSeconds: 300, output: 'downloading', agent: { name: 'Ada' } as ToolContext['agent'], signal: new AbortController().signal });
  assert.deepEqual(result, { action: 'wait', seconds: 120, reason: 'The decision model chose another 120 seconds.', by: 'systemone' });
  assert.match(requests[0].context!, /Tool output.*\n.*"status":"timeout".*"stillRunning":true.*downloading/);
  assert.ok(requests[0].options?.includes('Abort'));
});

test('default shell abort closes the real shell and its long-running descendant', { timeout: 30_000 }, async () => {
  const stop = new AbortController();
  const child = defaultShell('node -e "process.stdout.write(\'ready\'); setInterval(() => {}, 1000)"', { cwd: process.cwd(), signal: stop.signal });
  const closed = once(child as unknown as EventEmitter, 'close');
  try {
    await once(child.stdout! as EventEmitter, 'data', { signal: AbortSignal.timeout(20_000) });
    stop.abort();
    await closed;
  } finally { stop.abort(); }
});
