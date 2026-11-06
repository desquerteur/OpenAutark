// B-051 L2: things installed while the app runs are found without a restart – the finder's forced lookup
// on Windows also searches the machine + user PATH as the registry has it now (fresh-path.ts: two fixed
// `reg.exe query` calls, %VARS% expanded, undefined on any failure), and the standalone Codex installer's
// %LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe is a fixed candidate.
// Owns: nothing in production. Never runs reg.exe or touches the disk (scripted runner, supervisor and fs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutableFinder, type FinderEnv, type FsLike } from '../../../src/runtime/accounts/executables.ts';
import { expandVars, freshPath, parseRegPath } from '../../../src/runtime/accounts/fresh-path.ts';
import type { CliResult } from '../../../src/runtime/accounts/cli.ts';
import { fakeSpawn, testSupervisor, tick } from '../engines/fakes.ts';

const HKCU = 'HKCU\\Environment';
const HKLM = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const ENV: NodeJS.ProcessEnv = { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\p', LOCALAPPDATA: 'C:\\Users\\p\\AppData\\Local', PATH: 'C:\\Windows\\system32' };
const answer = (key: string, value: string): CliResult => ({ code: 0, stdout: `\r\n${key.replace(/^HKCU/, 'HKEY_CURRENT_USER').replace(/^HKLM/, 'HKEY_LOCAL_MACHINE')}\r\n    Path    REG_EXPAND_SZ    ${value}\r\n\r\n`, stderr: '', timedOut: false });

test('reg output: the Path value is read; %VARS% expand from the env (any case), unknown ones stay', () => {
  assert.equal(parseRegPath(answer(HKCU, '%USERPROFILE%\\.local\\bin;C:\\Tools').stdout), '%USERPROFILE%\\.local\\bin;C:\\Tools');
  assert.equal(parseRegPath('    Path    REG_SZ    C:\\One\r\n'), 'C:\\One');
  assert.equal(parseRegPath('ERROR: The system was unable to find the specified registry key or value.'), undefined);
  assert.equal(expandVars('%userprofile%\\bin;%SystemRoot%\\x;%NOPE%\\y', ENV), 'C:\\Users\\p\\bin;C:\\Windows\\x;%NOPE%\\y');
});

test('freshPath: machine then user PATH, expanded; not Windows, a timeout or an error → undefined', async () => {
  const asked: string[][] = [];
  const run = async (args: string[]) => { asked.push(args); return args[1] === HKLM ? answer(HKLM, '%SystemRoot%\\system32;C:\\Program Files\\nodejs\\') : answer(HKCU, '%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin'); };
  assert.equal(await freshPath({ platform: 'win32', env: ENV, run })(), 'C:\\Windows\\system32;C:\\Program Files\\nodejs\\;C:\\Users\\p\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin');
  assert.deepEqual(asked.sort(), [['query', HKCU, '/v', 'Path'], ['query', HKLM, '/v', 'Path']].sort(), 'two fixed queries');

  let ran = false;
  assert.equal(await freshPath({ platform: 'linux', env: ENV, run: async () => { ran = true; return answer(HKCU, 'x'); } })(), undefined);
  assert.equal(ran, false, 'nothing runs outside Windows');
  assert.equal(await freshPath({ platform: 'win32', env: ENV, run: async (args) => (args[1] === HKCU ? { code: null, stdout: '', stderr: '', timedOut: true } : answer(HKLM, 'C:\\x')) })(), undefined);
  assert.equal(await freshPath({ platform: 'win32', env: ENV, run: async () => { throw new Error('spawn failed'); } })(), undefined);
  // A user without an own Path value: the machine part alone.
  assert.equal(await freshPath({ platform: 'win32', env: ENV, run: async (args) => (args[1] === HKCU ? { code: 1, stdout: '', stderr: 'ERROR', timedOut: false } : answer(HKLM, 'C:\\x')) })(), 'C:\\x');
});

test('review B-051: relative, unexpanded and network entries never reach the finder (they would resolve against the process cwd)', async () => {
  const run = async (args: string[]) => (args[1] === HKLM
    ? answer(HKLM, 'C:\\Tools;.;bin;C:relative;%NEWVAR%\\bin;\\\\server\\share\\bin;;"C:\\Program Files\\nodejs"')
    : answer(HKCU, '..\\up;%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin;D:/Portable/node'));
  assert.equal(await freshPath({ platform: 'win32', env: ENV, run })(), 'C:\\Tools;C:\\Program Files\\nodejs;C:\\Users\\p\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin;D:/Portable/node');
  assert.equal(await freshPath({ platform: 'win32', env: ENV, run: async () => answer(HKCU, '.;bin;%NEWVAR%') })(), undefined, 'nothing usable: unknown');
});

test('freshPath through the supervisor: System32\\reg.exe with constant arguments, stopped after its time limit', async () => {
  const { spawn, calls } = fakeSpawn((call) => {
    if (call.args[1] === HKCU) return; // hangs
    setImmediate(() => { call.child.stdout.write(answer(HKLM, 'C:\\x').stdout); setImmediate(() => call.child.exit(0)); });
  });
  const read = freshPath({ platform: 'win32', env: ENV, supervisor: testSupervisor(spawn), timeoutMs: 30 });
  assert.equal(await read(), undefined, 'the user query timed out');
  assert.deepEqual(calls.map((call) => call.command), ['C:\\Windows\\System32\\reg.exe', 'C:\\Windows\\System32\\reg.exe']);
  assert.ok(calls.every((call) => call.args.length === 4 && call.args[0] === 'query' && call.args[2] === '/v' && call.args[3] === 'Path'));
  await tick();
  assert.ok(calls.every((call) => call.child.killed || call.child.exitCode === 0), 'no reg.exe left running');
});

/** A fake disk: files and their text; directories are implied by the files below them. */
function disk(files: Record<string, string>): FsLike {
  const lower = new Map(Object.keys(files).map((file) => [file.toLowerCase(), file]));
  const isDir = (p: string) => [...lower.keys()].some((file) => file.startsWith(`${p.toLowerCase()}\\`));
  return {
    stat: async (p) => { if (!lower.has(p.toLowerCase()) && !isDir(p)) throw new Error('ENOENT'); return { isFile: () => lower.has(p.toLowerCase()), isDirectory: () => isDir(p) }; },
    access: async (p) => { if (!lower.has(p.toLowerCase())) throw new Error('ENOENT'); },
    readdir: async (p) => {
      const prefix = `${p.toLowerCase()}\\`;
      const names = new Set([...lower.values()].filter((file) => file.toLowerCase().startsWith(prefix)).map((file) => file.slice(prefix.length).split('\\')[0]));
      return [...names].map((name) => ({ name, isFile: () => lower.has(`${prefix}${name.toLowerCase()}`), isDirectory: () => !lower.has(`${prefix}${name.toLowerCase()}`) }));
    },
    readFile: async (p) => { const file = lower.get(p.toLowerCase()); if (!file) throw new Error('ENOENT'); return files[file]; },
  };
}

function finderOn(files: Record<string, string>, fresh?: string) {
  const reads: number[] = [];
  const env: FinderEnv = {
    platform: 'win32', env: ENV, home: 'C:\\Users\\p', fs: disk(files),
    freshPath: async () => { reads.push(1); return fresh; },
  };
  return { finder: new ExecutableFinder(env), reads };
}

test('the standalone Codex installer\'s place is a fixed candidate (found without any PATH change)', async () => {
  const exe = 'C:\\Users\\p\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe';
  const { finder, reads } = finderOn({ [exe]: '' });
  assert.deepEqual(await finder.find('codex'), { command: exe, prefixArgs: [], path: exe });
  assert.equal(reads.length, 0, 'a normal lookup never reads the registry');
});

test('the Codex desktop app: the hashed folder with the code-mode helper wins over an old codex.exe left alone after an update', async () => {
  const bin = 'C:\\Users\\p\\AppData\\Local\\OpenAI\\Codex\\bin';
  const old = `${bin}\\0ab0e7a8f3779036\\codex.exe`;
  const usable = `${bin}\\22cfb1d302613eae\\codex.exe`;
  const { finder } = finderOn({ [old]: '', [`${bin}\\57159798136552f4\\rg.exe`]: '', [usable]: '', [`${bin}\\22cfb1d302613eae\\codex-code-mode-host.exe`]: '' });
  assert.equal((await finder.find('codex'))?.command, usable);
  assert.equal((await finderOn({ [old]: '' }).finder.find('codex'))?.command, old, 'no folder has the helper: still the one there is');
});

test('a codex.exe left alone after an update comes after every other install; the standalone installer\'s after a folder with the helper', async () => {
  const bin = 'C:\\Users\\p\\AppData\\Local\\OpenAI\\Codex\\bin';
  const old = `${bin}\\0ab0e7a8f3779036\\codex.exe`;
  const usable = `${bin}\\22cfb1d302613eae\\codex.exe`;
  const standalone = 'C:\\Users\\p\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe';
  const home = 'C:\\Users\\p\\.local\\bin\\codex.exe';
  assert.equal((await finderOn({ [old]: '', [standalone]: '' }).finder.find('codex'))?.command, standalone);
  assert.equal((await finderOn({ [old]: '', [home]: '' }).finder.find('codex'))?.command, home);
  assert.equal((await finderOn({ [old]: '', [standalone]: '', [usable]: '', [`${bin}\\22cfb1d302613eae\\codex-code-mode-host.exe`]: '' }).finder.find('codex'))?.command, usable);
});

test('a forced lookup sees the Codex update that came after the first lookup; a normal one keeps its cache', async () => {
  const bin = 'C:\\Users\\p\\AppData\\Local\\OpenAI\\Codex\\bin';
  const old = `${bin}\\0ab0e7a8f3779036\\codex.exe`;
  const fresh = `${bin}\\22cfb1d302613eae\\codex.exe`;
  const before = disk({ [old]: '' });
  const after = disk({ [old]: '', [fresh]: '', [`${bin}\\22cfb1d302613eae\\codex-code-mode-host.exe`]: '' });
  const fs: FsLike = { stat: (p) => now.stat(p), access: (p, mode) => now.access(p, mode), readdir: (p) => now.readdir(p), readFile: (p) => now.readFile(p) };
  let now = before;
  const finder = new ExecutableFinder({ platform: 'win32', env: ENV, home: 'C:\\Users\\p', fs });
  assert.equal((await finder.find('codex'))?.command, old);
  now = after;
  assert.equal((await finder.find('codex'))?.command, old, 'the process keeps what it found');
  assert.equal((await finder.find('codex', { force: true }))?.command, fresh);
});

test('a forced lookup also searches the PATH as Windows has it now; a normal one only the start PATH (cached)', async () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const npmShim = 'C:\\Program Files\\nodejs\\npm.cmd';
  const { finder, reads } = finderOn({ [node]: '', [npmShim]: '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n', 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js': '' }, 'C:\\Windows\\system32;C:\\Program Files\\nodejs\\');
  assert.equal(await finder.find('node'), null, 'installed after the start: not on the start PATH');
  assert.equal(reads.length, 0);
  assert.deepEqual(await finder.find('node', { force: true }), { command: node, prefixArgs: [], path: node });
  assert.equal(reads.length, 1);
  assert.deepEqual(await finder.find('node'), { command: node, prefixArgs: [], path: node }, 'the forced result is cached');
  // npm's shim runs its script with the Node.js found the same way.
  const npm = await finder.find('npm', { force: true });
  assert.deepEqual(npm, { command: node, prefixArgs: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'], path: npmShim });
});

test('a forced lookup on another platform or without a reader works as before', async () => {
  const exe = 'C:\\Tools\\codex.exe';
  const unreadable = finderOn({ [exe]: '' }, undefined);
  assert.equal(await unreadable.finder.find('codex', { force: true }), null, 'unknown fresh PATH: only the start PATH');
  const posix = new ExecutableFinder({ platform: 'linux', env: { PATH: '/usr/bin' }, home: '/home/p', fs: disk({}), freshPath: async () => { throw new Error('never on linux'); } });
  assert.equal(await posix.find('codex', { force: true }), null);
});
