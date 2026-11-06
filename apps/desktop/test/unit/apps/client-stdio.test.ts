// B-052 track A: the MCP client over stdio against a real child process (test/fixtures/apps/fake-stdio-server.mjs
// run with process.execPath through the default supervisor spawner) and an injected fake spawner: the handshake
// with non-JSON lines and split chunks around it, a server request answered -32601, list_changed, the small env
// (own values in, the runtime's others out), cancel → notifications/cancelled, a crash mid-call (sent: true, the
// stderr line), a program that dies at start (tokens and env values hidden), garbage output (hint), 2024-11-05,
// the server/discover fallback, a missing program, close (stdin EOF, no kill needed).
// Owns: checks of runtime/apps/client/{stdio,session,index}.ts over stdio only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { connectMcp, McpTimeout } from '../../../src/runtime/apps/client/index.ts';
import { redactLine } from '../../../src/runtime/apps/client/stdio.ts';
import { McpTransportError, type McpConnection, type StdioChild, type StdioSpawner } from '../../../src/runtime/apps/types.ts';

const FIXTURE = fileURLToPath(new URL('../../fixtures/apps/fake-stdio-server.mjs', import.meta.url));
const CLIENT = { clientInfo: { name: 'workforce', version: '0.2.0' } };

function open(mode: string, env?: Record<string, string>, timeoutMs?: number): Promise<McpConnection> {
  return connectMcp({ kind: 'stdio', command: process.execPath, args: [FIXTURE, mode], env }, { ...CLIENT, timeoutMs });
}

async function state(connection: McpConnection): Promise<{ replies: Array<{ id: string; error?: { code: number } }>; cancelled: Array<{ requestId: number; reason: string }>; initialized: boolean }> {
  const result = await connection.callTool('state', {});
  return JSON.parse((result.content[0] as { text: string }).text);
}

test('stdio handshake through log lines and split chunks; tools; a server request gets -32601; list_changed; close is quick', async () => {
  const connection = await open('normal');
  try {
    assert.deepEqual(connection.info, { protocolVersion: '2025-06-18', name: 'stdio-fake', version: '0.1' });
    let changed = 0;
    connection.onToolsChanged(() => { changed++; });
    const tools = await connection.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ['echo', 'env', 'slow', 'crash', 'state']);
    assert.equal(changed, 1);
    const echo = await connection.callTool('echo', { text: 'grüße' });
    assert.deepEqual(echo.content, [{ type: 'text', text: 'echo {"text":"grüße"} ünïcødé' }]);
    const seen = await state(connection);
    assert.equal(seen.initialized, true, 'notifications/initialized was sent');
    assert.deepEqual(seen.replies, [{ jsonrpc: '2.0', id: 'srv-1', error: { code: -32601, message: 'Not supported by this client.' } }]);
  } finally {
    const started = Date.now();
    await connection.close();
    assert.ok(Date.now() - started < 1_900, 'the program ended on stdin EOF, no kill wait');
  }
});

test('the child sees PATH and its own env, never the runtime\'s other variables', async () => {
  process.env.WORKFORCE_LEAK_CHECK = 'must-not-leak';
  const connection = await open('normal', { APP_OWN: 'mine' });
  try {
    const result = await connection.callTool('env', {});
    assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), { path: true, own: 'mine', leaked: null });
  } finally {
    delete process.env.WORKFORCE_LEAK_CHECK;
    await connection.close();
  }
});

test('cancel sends notifications/cancelled with the request id; a timeout too', async () => {
  const connection = await open('normal');
  try {
    const controller = new AbortController();
    const pending = connection.callTool('slow', {}, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('person stopped it')), 30);
    await assert.rejects(pending, /person stopped it/);
    const timedOut = await connection.callTool('slow', {}, { timeoutMs: 60 }).catch((caught: unknown) => caught);
    assert.ok(timedOut instanceof McpTimeout);
    assert.equal(timedOut.sent, true);
    const seen = await state(connection);
    assert.deepEqual(seen.cancelled.map((entry) => entry.reason), ['The request was cancelled.', 'The request timed out.']);
    assert.ok(seen.cancelled.every((entry) => typeof entry.requestId === 'number'));
  } finally {
    await connection.close();
  }
});

test('a crash during a tools/call rejects it with sent: true and the program\'s stderr line; later calls fail fast', async () => {
  const connection = await open('normal');
  try {
    const error = await connection.callTool('crash', {}).catch((caught: unknown) => caught);
    assert.ok(error instanceof McpTransportError);
    assert.equal(error.sent, true);
    assert.equal(error.message, 'The app\'s program stopped: fatal: lost database connection');
    const later = await connection.listTools().catch((caught: unknown) => caught);
    assert.ok(later instanceof McpTransportError);
    assert.equal(later.sent, false);
  } finally {
    await connection.close();
  }
});

test('a program that dies at start: its error line, with tokens and the app\'s own env values hidden', async () => {
  const error = await open('dies', { API_KEY: 'MY_SECRET_VALUE_42' }).catch((caught: unknown) => caught);
  assert.ok(error instanceof McpTransportError);
  assert.equal(error.sent, false);
  assert.match(error.message, /^The app's program stopped: Error: invalid API key \[hidden\] \(\[hidden\] rejected\)$/);
  assert.doesNotMatch(error.message, /sk-test|MY_SECRET/);
});

test('a program that only prints text: the handshake times out with a hint; 2024-11-05 over stdio is accepted', async () => {
  const error = await open('garbage', undefined, 300).catch((caught: unknown) => caught);
  assert.ok(error instanceof McpTimeout);
  assert.equal(error.message, 'The app\'s program wrote text that is not MCP.');
  const old = await open('old');
  try {
    assert.equal(old.info.protocolVersion, '2024-11-05');
    assert.equal((await old.listTools()).length, 5);
  } finally {
    await old.close();
  }
});

test('initialize refused (-32601) → server/discover; every later request carries _meta', async () => {
  const connection = await open('modern');
  try {
    assert.deepEqual(connection.info, { protocolVersion: '2026-07-28', name: 'stdio-modern', version: '9' });
    assert.equal((await connection.listTools()).length, 5, 'the fixture refuses requests without _meta');
  } finally {
    await connection.close();
  }
});

test('a program that does not exist: a user-safe "not found"', async () => {
  const error = await connectMcp({ kind: 'stdio', command: 'workforce-no-such-program-b052', args: [] }, CLIENT).catch((caught: unknown) => caught);
  assert.ok(error instanceof McpTransportError);
  assert.equal(error.message, 'The app\'s program was not found: workforce-no-such-program-b052.');
});

test('injected spawner: gets the env, newline-delimited JSON both ways, exit with a pending call rejects it (sent)', async () => {
  const calls: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
  let exit: ((code: number | null) => void) | undefined;
  const stdout = new PassThrough();
  const written: string[] = [];
  const spawn: StdioSpawner = (command, args, opts) => {
    calls.push({ command, args, env: opts.env });
    const child: StdioChild = {
      stdin: {
        write: (chunk: string) => {
          written.push(chunk);
          const message = JSON.parse(chunk) as { id?: number; method: string };
          if (message.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26' } })}\n`);
          if (message.method === 'tools/call') setTimeout(() => exit?.(1), 10);
          return true;
        },
        end: () => undefined,
      },
      stdout,
      kill: () => true,
      once: (_event, listener) => { exit = listener; return child; },
    };
    return child;
  };
  const connection = await connectMcp({ kind: 'stdio', command: 'fake-mcp', args: ['--flag'], env: { TOKEN_VALUE: 'abcdef' } }, { ...CLIENT, spawn });
  assert.equal(calls[0].command, 'fake-mcp');
  assert.deepEqual(calls[0].args, ['--flag']);
  assert.equal(calls[0].env.TOKEN_VALUE, 'abcdef');
  assert.ok(written.every((line) => line.endsWith('\n') && !line.slice(0, -1).includes('\n')));
  assert.equal(JSON.parse(written[1]).method, 'notifications/initialized');
  const error = await connection.callTool('anything', {}).catch((caught: unknown) => caught);
  assert.ok(error instanceof McpTransportError);
  assert.equal(error.sent, true);
  assert.equal(error.message, 'The app\'s program stopped.');
  await connection.close();
});

test('redactLine hides token-like runs, key=value secrets and known values; keeps ordinary words and paths', () => {
  assert.equal(redactLine('Authorization: Bearer abc.def', []), 'Authorization: [hidden] [hidden]');
  assert.equal(redactLine('api_key=12345 and password: "hunter2"', []), 'api_key=[hidden] and password: "[hidden]"');
  assert.equal(redactLine('token ghp_A1b2C3d4E5f6G7h8I9j0 failed', []), 'token [hidden] failed');
  assert.equal(redactLine('Error: Cannot find module \'@modelcontextprotocol/server-filesystem\'', []), 'Error: Cannot find module \'@modelcontextprotocol/server-filesystem\'');
  assert.equal(redactLine('connect to db with s3cr3tvalue failed', ['s3cr3tvalue']), 'connect to db with [hidden] failed');
  assert.equal(redactLine('a\u0000b\tc', []), 'a b c');
});
