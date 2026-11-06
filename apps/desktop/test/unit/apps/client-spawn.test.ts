// B-052 track A: starting stdio MCP servers – what Windows would run for a bare command (PATH + PATHEXT, case-
// insensitive env names), npm's npx.cmd and cmd-shim launchers resolved to node + script or the .exe they name,
// an unreadable .cmd only through `cmd /d /c` with plain arguments (refused otherwise), POSIX untouched; the small
// inherited env plus the app's own values; the supervisor adapter (tree kill on kill(), start errors kept).
// Owns: checks of runtime/apps/client/spawn.ts only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { childEnv, resolveCommand, startErrorOf, supervisorSpawner, type ResolveDeps } from '../../../src/runtime/apps/client/spawn.ts';
import type { Lease, Supervisor } from '../../../src/runtime/system/supervisor.ts';

const NPX_CMD = [
  ':: Created by npm, please don\'t edit manually.',
  '@ECHO OFF',
  'SETLOCAL',
  'SET "NODE_EXE=%~dp0\\node.exe"',
  'IF NOT EXIST "%NODE_EXE%" (',
  '  SET "NODE_EXE=node"',
  ')',
  'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
  'SET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"',
  'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
  '  SET "NPM_PREFIX_NPX_CLI_JS=%%F\\node_modules\\npm\\bin\\npx-cli.js"',
  ')',
  'IF EXIST "%NPM_PREFIX_NPX_CLI_JS%" (',
  '  SET "NPX_CLI_JS=%NPM_PREFIX_NPX_CLI_JS%"',
  ')',
  '"%NODE_EXE%" "%NPX_CLI_JS%" %*',
].join('\r\n');

const CMD_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@acme\\mcp-server\\dist\\index.js" %*',
].join('\r\n');

function winDeps(files: Record<string, string>, env: NodeJS.ProcessEnv = { Path: 'C:\\nodejs;C:\\Users\\me\\AppData\\Roaming\\npm;C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' }): ResolveDeps {
  const known = new Map(Object.entries(files).map(([file, text]) => [file.toLowerCase(), text]));
  return {
    platform: 'win32',
    env,
    isFile: async (file) => known.has(file.toLowerCase()),
    readText: async (file) => known.get(file.toLowerCase()),
  };
}

test('npx → npm\'s npx.cmd → node.exe next to it + npx-cli.js, the arguments untouched', async () => {
  const deps = winDeps({ 'C:\\nodejs\\npx.cmd': NPX_CMD, 'C:\\nodejs\\node.exe': '', 'C:\\nodejs\\node_modules\\npm\\bin\\npx-cli.js': '', 'C:\\nodejs\\node_modules\\npm\\bin\\npm-prefix.js': '' });
  assert.deepEqual(await resolveCommand('npx', ['-y', '@modelcontextprotocol/server-everything', 'a b'], deps), {
    command: 'C:\\nodejs\\node.exe', args: ['C:\\nodejs\\node_modules\\npm\\bin\\npx-cli.js', '-y', '@modelcontextprotocol/server-everything', 'a b'],
  });
  assert.deepEqual(await resolveCommand('NPX.CMD', [], deps), { command: 'C:\\nodejs\\node.exe', args: ['C:\\nodejs\\node_modules\\npm\\bin\\npx-cli.js'] });
});

test('a cmd-shim of a global package → the script with node from PATH; an .exe shim → that program; .exe found directly', async () => {
  const npm = 'C:\\Users\\me\\AppData\\Roaming\\npm';
  const deps = winDeps({
    [`${npm}\\acme-mcp.cmd`]: CMD_SHIM,
    [`${npm}\\node_modules\\@acme\\mcp-server\\dist\\index.js`]: '',
    'C:\\nodejs\\node.exe': '',
    [`${npm}\\fast-mcp.cmd`]: '@ECHO off\r\n"%~dp0\\node_modules\\fast\\bin\\fast.exe"   %*\r\n',
    [`${npm}\\node_modules\\fast\\bin\\fast.exe`]: '',
    'C:\\tools\\uvx.exe': '',
  });
  assert.deepEqual(await resolveCommand('acme-mcp', ['--port', '1'], deps), { command: 'C:\\nodejs\\node.exe', args: [`${npm}\\node_modules\\@acme\\mcp-server\\dist\\index.js`, '--port', '1'] });
  assert.deepEqual(await resolveCommand('fast-mcp', ['x'], deps), { command: `${npm}\\node_modules\\fast\\bin\\fast.exe`, args: ['x'] });
  assert.deepEqual(await resolveCommand('uvx', ['mcp-server-git'], deps), { command: 'C:\\tools\\uvx.exe', args: ['mcp-server-git'] });
});

test('an unreadable .bat runs through cmd /d /c only with plain arguments; otherwise it is refused', async () => {
  const deps = winDeps({ 'C:\\tools\\run-server.bat': '@echo off\r\npython server.py %*\r\n' }, { PATH: 'C:\\tools', COMSPEC: 'C:\\Windows\\system32\\cmd.exe' });
  assert.deepEqual(await resolveCommand('run-server', ['--mode=fast', 'C:\\data\\x.db'], deps), {
    command: 'C:\\Windows\\system32\\cmd.exe', args: ['/d', '/c', 'C:\\tools\\run-server.bat', '--mode=fast', 'C:\\data\\x.db'],
  });
  for (const unsafe of ['a&b', 'two words', '%PATH%', 'x"y', 'a|b', '']) {
    const result = await resolveCommand('run-server', [unsafe], deps);
    assert.ok('refused' in result, `refused: ${JSON.stringify(unsafe)}`);
  }
});

test('not found, an absolute path, a cwd-relative path and POSIX are passed through as given', async () => {
  const deps = winDeps({ 'D:\\work\\bin\\srv.exe': '' });
  assert.deepEqual(await resolveCommand('missing-tool', ['a'], deps), { command: 'missing-tool', args: ['a'] });
  assert.deepEqual(await resolveCommand('D:\\work\\bin\\srv', [], deps), { command: 'D:\\work\\bin\\srv.exe', args: [] });
  assert.deepEqual(await resolveCommand('bin\\srv.exe', [], deps, 'D:\\work'), { command: 'D:\\work\\bin\\srv.exe', args: [] });
  const posix: ResolveDeps = { ...deps, platform: 'linux', isFile: async () => { throw new Error('not consulted'); } };
  assert.deepEqual(await resolveCommand('npx', ['-y', 'pkg'], posix), { command: 'npx', args: ['-y', 'pkg'] });
});

test('childEnv: the small base (Windows names in any case), shell functions out, the app\'s own values on top', () => {
  const env = { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', APPDATA: 'C:\\A', OPENAI_API_KEY: 'sk-x', GITHUB_TOKEN: 'ghp', BASH_FUNC_x: '() { :; }', TEMP: 'C:\\T' };
  assert.deepEqual(childEnv({ PATH: 'C:\\own', MY_KEY: 'v' }, 'win32', env), { SystemRoot: 'C:\\Windows', APPDATA: 'C:\\A', TEMP: 'C:\\T', PATH: 'C:\\own', MY_KEY: 'v' });
  assert.deepEqual(childEnv(undefined, 'linux', { HOME: '/h', PATH: '/bin', Path: 'x', AWS_SECRET_ACCESS_KEY: 's', SHELLFN: '() {}', LANG: 'C' }), { HOME: '/h', PATH: '/bin', LANG: 'C' });
});

test('supervisorSpawner: a light lease with the env and cwd; kill() releases the lease (tree kill); start errors are kept', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 42, exitCode: null, kill: () => true });
  let released = 0;
  let resolveExit!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => { resolveExit = resolve; });
  const asked: unknown[] = [];
  const supervisor = {
    spawn: (input: unknown) => {
      asked.push(input);
      return { child, exited, release: async () => { released++; resolveExit(null); } } as unknown as Lease;
    },
  } as Pick<Supervisor, 'spawn'>;
  const spawn = supervisorSpawner(supervisor, 'app:notion');
  const stdio = spawn('node.exe', ['server.js'], { env: { A: '1' }, cwd: 'C:\\w' });
  assert.deepEqual(asked, [{ command: 'node.exe', args: ['server.js'], owner: 'app:notion', kind: 'light', env: { A: '1' }, cwd: 'C:\\w', stdio: ['pipe', 'pipe', 'pipe'] }]);
  const codes: Array<number | null> = [];
  stdio.once('exit', (code) => codes.push(code));
  child.emit('error', Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' }));
  assert.equal(startErrorOf(stdio), 'ENOENT');
  child.stdin.emit('error', new Error('EPIPE')); // no crash: the adapter listens
  assert.equal(stdio.kill(), true);
  await exited;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, 1);
  assert.deepEqual(codes, [null]);
});
