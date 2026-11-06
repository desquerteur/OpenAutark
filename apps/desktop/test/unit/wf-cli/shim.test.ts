// B-072: the agents' `wf` (engines/wf-shim.ts) – the shim texts for sh and cmd, the wf.mjs path of a packaged
// build, PATH order and AUTARK_DATA of the agents' env, writing only what changed, nothing without wf.mjs, the
// registry handing the env to its CLI engines, and the shim really running a script with this node (sh; on Windows
// cmd, and Git Bash in a non-UTF-8 locale when one is installed).
// Owns: these assertions only. Never: writes outside its temp folder or starts the app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentEnv, shimDir, shimFiles, wfEntry, withShim } from '../../../src/runtime/engines/wf-shim.ts';
import { createEngineRegistry } from '../../../src/runtime/engines/registry.ts';
import { account, acpAgent, fakeFinder, testSupervisor } from '../engines/fakes.ts';

const text = (files: Array<{ name: string; text: string }>, name: string) => files.find((file) => file.name === name)?.text;

function temp(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'wf-shim-'));
}

test('wf.mjs lies beside the runtime bundle; a packaged build reads it from app.asar.unpacked', () => {
  assert.equal(wfEntry(path.join('/dev', 'desktop', 'app', 'runtime.mjs')), path.join('/dev', 'desktop', 'app', 'wf.mjs'));
  assert.equal(
    wfEntry(path.join('/opt', 'Autark', 'resources', 'app.asar', 'app', 'runtime.mjs')),
    path.join('/opt', 'Autark', 'resources', 'app.asar.unpacked', 'app', 'wf.mjs'),
  );
});

test('macOS and Linux get one sh shim that runs wf.mjs with the app binary as Node', () => {
  const files = shimFiles({ executable: "/Applications/Autark.app/Contents/MacOS/Autark", entry: "/opt/it's/app/wf.mjs" }, 'darwin', '/data/bin');
  assert.deepEqual(files.map((file) => file.name), ['wf']);
  const lines = text(files, 'wf')!.split('\n');
  assert.equal(lines[0], '#!/bin/sh');
  assert.equal(lines[2], 'export ELECTRON_RUN_AS_NODE=1');
  assert.equal(lines[3], `exec '/Applications/Autark.app/Contents/MacOS/Autark' '/opt/it'\\''s/app/wf.mjs' "$@"`);
  assert.ok(!text(files, 'wf')!.includes('\r'));
});

test('Windows gets wf for Git Bash and wf.cmd, both with paths relative to the shim on its own drive', () => {
  const dir = 'C:\\Users\\Jürgen\\AppData\\Roaming\\Autark\\bin';
  const files = shimFiles({
    executable: 'C:\\Users\\Jürgen\\AppData\\Local\\Programs\\Autark\\Autark.exe',
    entry: 'D:\\100%\\resources\\app.asar.unpacked\\app\\wf.mjs',
  }, 'win32', dir);
  assert.deepEqual(files.map((file) => file.name), ['wf', 'wf.cmd']);
  // The same drive: relative to the shim's folder (Git Bash: pwd -W, builtins only; cmd: %~dp0), so the user name
  // stays out of both files; another drive: absolute (sh: forward slashes; cmd: % doubled).
  assert.deepEqual(text(files, 'wf')!.split('\n').slice(2), [
    'case $0 in */*) d=${0%/*} ;; *) d=. ;; esac',
    'd=$(CDPATH= cd -- "$d" && pwd -W)',
    'export ELECTRON_RUN_AS_NODE=1',
    `exec "$d"'/../../../Local/Programs/Autark/Autark.exe' 'D:/100%/resources/app.asar.unpacked/app/wf.mjs' "$@"`,
    '',
  ]);
  const cmd = text(files, 'wf.cmd')!.split('\n');
  assert.deepEqual([cmd[0], cmd[2], cmd[3]], ['@echo off', 'setlocal', 'set ELECTRON_RUN_AS_NODE=1']);
  assert.equal(cmd[4], '"%~dp0..\\..\\..\\Local\\Programs\\Autark\\Autark.exe" "D:\\100%%\\resources\\app.asar.unpacked\\app\\wf.mjs" %*');
  for (const file of files) {
    assert.ok(!file.text.includes('Jürgen'), file.name);
    assert.ok(!file.text.includes('\r'), file.name);
  }
  const quoted = shimFiles({ executable: "C:\\it's\\Autark.exe", entry: 'C:\\app\\wf.mjs' }, 'win32', 'C:\\data\\bin');
  assert.match(text(quoted, 'wf')!, /\nexec "\$d"'\/\.\.\/\.\.\/it'\\''s\/Autark\.exe' "\$d"'\/\.\.\/\.\.\/app\/wf\.mjs' "\$@"\n$/);
});

test('the agents env: the shim folder first on PATH, once, and AUTARK_DATA; the base stays as it was', () => {
  const base = { PATH: '/data/bin:/usr/bin:/bin', HOME: '/home/a' };
  const env = withShim(base, '/data', '/data/bin', 'linux');
  assert.equal(env.PATH, '/data/bin:/usr/bin:/bin');
  assert.equal(env.AUTARK_DATA, '/data');
  assert.equal(env.HOME, '/home/a');
  assert.equal(withShim({ PATH: '/usr/bin' }, '/data', '/data/bin', 'linux').PATH, '/data/bin:/usr/bin');
  assert.equal(withShim({}, '/data', '/data/bin', 'linux').PATH, '/data/bin');
  assert.deepEqual(base, { PATH: '/data/bin:/usr/bin:/bin', HOME: '/home/a' });
  // Windows: the variable keeps its own spelling (one key, never Path and PATH), ';' between entries – before system32.
  const win = withShim({ Path: 'C:\\WINDOWS\\system32;C:\\Tools', SystemRoot: 'C:\\WINDOWS' }, 'C:\\D', 'C:\\D\\bin', 'win32');
  assert.equal(win.Path, 'C:\\D\\bin;C:\\WINDOWS\\system32;C:\\Tools');
  assert.equal(win.PATH, undefined);
  // No shim (no wf.mjs): PATH as it was, AUTARK_DATA still set.
  assert.deepEqual(withShim({ PATH: '/usr/bin' }, '/data', undefined, 'linux'), { PATH: '/usr/bin', AUTARK_DATA: '/data' });
});

test('agentEnv writes the shim once, rewrites it when the app moved, and writes nothing without wf.mjs', (t) => {
  const root = temp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const entry = path.join(root, 'app', 'wf.mjs');
  const none = agentEnv(data, { entry, env: { PATH: '/usr/bin' }, platform: 'linux', executable: '/opt/a/autark' });
  assert.equal(existsSync(shimDir(data)), false, 'no wf.mjs: no bin folder');
  assert.deepEqual(none, { PATH: '/usr/bin', AUTARK_DATA: data });

  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, '');
  const env = agentEnv(data, { entry, env: { Path: 'C:\\WINDOWS\\system32' }, platform: 'win32', executable: 'C:\\A\\Autark.exe' });
  const dir = shimDir(data);
  assert.equal(env.Path, `${dir};C:\\WINDOWS\\system32`);
  const wf = path.join(dir, 'wf');
  const cmd = path.join(dir, 'wf.cmd');
  assert.equal(readFileSync(cmd, 'utf8'), text(shimFiles({ executable: 'C:\\A\\Autark.exe', entry }, 'win32', dir), 'wf.cmd'));
  assert.ok(!readFileSync(wf, 'utf8').includes('\r'));

  const old = new Date('2026-01-01T00:00:00Z');
  utimesSync(cmd, old, old);
  agentEnv(data, { entry, env: {}, platform: 'win32', executable: 'C:\\A\\Autark.exe' });
  assert.equal(statSync(cmd).mtimeMs, old.getTime(), 'same text: not written again');
  agentEnv(data, { entry, env: {}, platform: 'win32', executable: 'C:\\B\\Autark.exe' });
  assert.match(readFileSync(cmd, 'utf8'), /B\\Autark\.exe/);
});

test('the registry hands the agents env to its CLI engines (an ACP agent sees AUTARK_DATA)', async (t) => {
  const data = temp();
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const agent = acpAgent();
  const registry = createEngineRegistry({
    supervisor: testSupervisor(agent.spawn), finder: fakeFinder({}), paths: { temp: path.join(data, 'tmp'), data }, version: '1',
    apiKey: async () => undefined, acp: async () => ({ name: 'Fake Agent', command: '/bin/fake-agent', args: ['--acp'], env: {} }),
  });
  const engine = registry.get('acp');
  assert.equal((await engine.checkAccount(account({ id: 'acc_acp', provider: 'gemini' }))).state, 'ok');
  assert.equal(agent.calls[0].options.env?.AUTARK_DATA, data);
  await registry.dispose();
});

/** A Git Bash beside a git on PATH (Git\usr\bin, or Git\bin next to Git\cmd) – never WSL's bash in system32. */
function gitBash(): string | undefined {
  const system = (process.env.SystemRoot ?? 'C:\\Windows').toLowerCase();
  return (process.env.Path ?? process.env.PATH ?? '').split(';').filter((dir) => dir && !dir.toLowerCase().startsWith(system))
    .flatMap((dir) => [path.join(dir, 'bash.exe'), path.join(dir, '..', 'bin', 'bash.exe')]).find((file) => existsSync(file));
}

test('the written shim runs wf.mjs with this node, its arguments and ELECTRON_RUN_AS_NODE, found by name on PATH', (t) => {
  const root = path.join(temp(), 'Jürgen');
  t.after(() => rmSync(path.dirname(root), { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const entry = path.join(root, 'app', 'wf.mjs');
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, 'console.log(JSON.stringify({ args: process.argv.slice(2), node: process.env.ELECTRON_RUN_AS_NODE, data: process.env.AUTARK_DATA }));\n');
  const win = process.platform === 'win32';
  // PATH holds the shim folder only: a name that did not resolve there could never reach another `wf` (system32\WF.msc).
  const env = agentEnv(data, { entry, env: win ? { SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT } : {} });
  const runs = win
    ? [spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'wf call "two words"'], { env, encoding: 'utf8', windowsVerbatimArguments: true })]
    : [spawnSync('/bin/sh', ['-c', 'wf call "two words"'], { env, encoding: 'utf8' })];
  // Git Bash (Claude Code's shell on Windows), from a folder under its /tmp mount.
  const bash = win ? gitBash() : undefined;
  if (bash) {
    runs.push(spawnSync(bash, ['-c', "wf call 'two words'"], { env, encoding: 'utf8' }));
    // A locale that is not UTF-8: the paths still reach node, since they come from the shim's folder, not the file
    // (MSYS itself hands on such a shell's non-ASCII env values mangled – AUTARK_DATA here, APPDATA alike).
    const latin = spawnSync(bash, ['-c', "wf call 'two words'"], { env: { ...env, LANG: 'de_DE' }, encoding: 'utf8' });
    assert.equal(latin.status, 0, latin.stderr);
    assert.deepEqual(JSON.parse(latin.stdout.trim()).args, ['call', 'two words']);
  }
  for (const run of runs) {
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout.trim()), { args: ['call', 'two words'], node: '1', data });
  }
});
