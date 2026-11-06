// assets/installer.nsh's folder rule through the real makensis of electron-builder's cache, warnings as errors as in a
// real build: a tiny installer includes the file, runs the macros on a given $INSTDIR and writes the result. It does
// not build the full installer template, and nothing here installs anything (skipped where makensis is not cached).
// B-078: the fast running check (customCheckAppRunning) runs in a stub too, once with nothing running and once against
// a copied ping.exe under a throwaway image name, which it ends.
import { after, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function findMakensis(): string | null {
  const cache = path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache');
  try {
    for (const entry of readdirSync(cache)) {
      if (!entry.startsWith('nsis-3')) continue;
      for (const inner of readdirSync(path.join(cache, entry))) {
        const file = path.join(cache, entry, inner, 'makensis.exe');
        if (existsSync(file)) return file;
      }
    }
  } catch { /* no cache */ }
  return null;
}

const makensis = process.platform === 'win32' ? findMakensis() : null;
const root = mkdtempSync(path.join(os.tmpdir(), 'wf-nsh-'));
after(() => rmSync(root, { recursive: true, force: true }));
const installerNsh = path.resolve('assets', 'installer.nsh');

let counter = 0;
/** The folder the rule chose; null when Windows would not start the fresh unsigned stub (Smart App Control refuses some). */
function runFolderRule(appFilename: string, instdir: string, mode: 'customInit' | 'page'): string | null {
  counter += 1;
  const dir = path.join(root, `case${counter}`);
  rmSync(dir, { recursive: true, force: true });
  const script = path.join(root, `case${counter}.nsi`);
  const exe = path.join(root, `case${counter}.exe`);
  const result = path.join(root, `case${counter}.txt`);
  writeFileSync(script, [
    'Unicode true',
    'SetCompressor zlib',
    `!define APP_FILENAME "${appFilename}"`,
    '!include LogicLib.nsh',
    '!include FileFunc.nsh',
    '!include nsDialogs.nsh',
    // electron-builder generates these two flag tests (nsisScriptGenerator.flags); here always true, so the update
    // relaunch in customInstall compiles too (the section never runs: .onInit quits first).
    ...['isUpdated', 'isForceRun'].flatMap(flag => [`!macro _${flag} _a _b _t _f`, '  StrCmp "1" "1" `${_t}` `${_f}`', '!macroend', `!define ${flag} \`"" ${flag} ""\``]),
    'Var launchLink',
    'Var appExe',
    'Var installMode', // electron-builder's multiUser.nsh: "all" or "CurrentUser"
    `!include "${installerNsh}"`,
    `OutFile "${exe}"`,
    'SilentInstall silent',
    'RequestExecutionLevel user',
    'Function .onInit',
    `  StrCpy $INSTDIR "${instdir}"`,
    mode === 'customInit' ? '  !insertmacro customInit' : '  !insertmacro identityFolder',
    '  StrCpy $launchLink ""',
    '  StrCpy $appExe ""',
    '  StrCpy $installMode CurrentUser',
    `  FileOpen $0 "${result}" w`,
    '  FileWrite $0 "$INSTDIR"',
    '  FileClose $0',
    '  SetErrorLevel 0', // Quit in .onInit otherwise reports 2, "aborted by script"
    '  Quit',
    'FunctionEnd',
    ...(mode === 'page' ? ['!insertmacro customPageAfterChangeDir'] : []),
    'Section',
    '  !insertmacro customInstall',
    '  DetailPrint "$launchLink$appExe"',
    'SectionEnd',
    '',
  ].join('\r\n'));
  const compile = spawnSync(makensis!, ['-WX', '-V2', script], { encoding: 'utf8' });
  assert.equal(compile.status, 0, `${compile.stdout}\n${compile.stderr}`);
  const run = spawnSync(exe, ['/S'], { encoding: 'utf8' });
  if (run.error) return null;
  assert.equal(run.status, 0);
  return readFileSync(result, 'utf8');
}

/** A new compile is a new file, which Windows may start; after three refusals only the compile was checked, and the test says so. */
function expectFolder(t: TestContext, appFilename: string, instdir: string, mode: 'customInit' | 'page', expected: string): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const folder = runFolderRule(appFilename, instdir, mode);
    if (folder !== null) { assert.equal(folder, expected); return; }
  }
  t.diagnostic(`not run, Windows refused the stub: ${instdir}`);
}

const OLD = 'Proactive Agent Workforce';

test('an install in a folder named after the old product goes to the new folder in the same place', { skip: !makensis }, (t) => {
  expectFolder(t, 'Autark', `C:\\Users\\A\\AppData\\Local\\Programs\\${OLD}`, 'customInit', 'C:\\Users\\A\\AppData\\Local\\Programs\\Autark');
  expectFolder(t, 'Autark', `D:\\Apps\\${OLD}`, 'customInit', 'D:\\Apps\\Autark');
  expectFolder(t, 'Autark', `D:\\Apps\\proactive agent workforce`, 'customInit', 'D:\\Apps\\Autark'); // NSIS compares without case, as Windows does
});

test('any other folder stays, and with the old product name in place nothing changes', { skip: !makensis }, (t) => {
  expectFolder(t, 'Autark', 'D:\\Apps\\Autark', 'customInit', 'D:\\Apps\\Autark');
  expectFolder(t, 'Autark', 'D:\\My Tools', 'customInit', 'D:\\My Tools');
  expectFolder(t, OLD, `C:\\P\\${OLD}`, 'customInit', `C:\\P\\${OLD}`);
});

test('the windowless page for installers with pages compiles with warnings as errors', { skip: !makensis }, (t) => {
  expectFolder(t, 'Autark', `D:\\Apps\\${OLD}`, 'page', 'D:\\Apps\\Autark');
});

/**
 * customCheckAppRunning in a tiny silent installer: its exit code and how long the check itself took (the stub writes
 * GetTickCount before and after, so Windows' scan of the fresh file is not counted); null when Windows refused three
 * new stubs. `updated` is what electron-builder's ${isUpdated} answers (an installer started with --updated).
 */
function runRunningCheck(image: string, updated = false): { status: number | null; ms: number } | null {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = runRunningCheckOnce(image, updated);
    if (result) return result;
  }
  return null;
}

function runRunningCheckOnce(image: string, updated: boolean): { status: number | null; ms: number } | null {
  counter += 1;
  const script = path.join(root, `check${counter}.nsi`);
  const exe = path.join(root, `check${counter}.exe`);
  const timing = path.join(root, `check${counter}.ms`);
  writeFileSync(script, [
    'Unicode true',
    'SetCompressor zlib',
    `!define APP_EXECUTABLE_FILENAME "${image}"`,
    '!define PRODUCT_NAME "Autark"',
    '!include LogicLib.nsh',
    '!include FileFunc.nsh',
    '!include nsDialogs.nsh',
    '!macro _isUpdated _a _b _t _f',
    `  StrCmp "${updated ? 1 : 0}" "1" \`\${_t}\` \`\${_f}\``,
    '!macroend',
    '!define isUpdated `"" isUpdated ""`',
    `!include "${installerNsh}"`,
    `OutFile "${exe}"`,
    'SilentInstall silent',
    'RequestExecutionLevel user',
    'Function .onInit',
    '  System::Call "kernel32::GetTickCount() i .r8"',
    '  !insertmacro customCheckAppRunning',
    '  System::Call "kernel32::GetTickCount() i .r9"',
    '  IntOp $9 $9 - $8',
    `  FileOpen $0 "${timing}" w`,
    '  FileWrite $0 "$9"',
    '  FileClose $0',
    '  SetErrorLevel 0',
    '  Quit',
    'FunctionEnd',
    'Section',
    'SectionEnd',
    '',
  ].join('\r\n'));
  const compile = spawnSync(makensis!, ['-WX', '-V2', script], { encoding: 'utf8' });
  assert.equal(compile.status, 0, `${compile.stdout}\n${compile.stderr}`);
  const run = spawnSync(exe, ['/S'], { encoding: 'utf8', timeout: 60_000 });
  if (run.error || !existsSync(timing)) return null;
  return { status: run.status, ms: Number(readFileSync(timing, 'utf8')) };
}

test('the running check: nothing running passes at once, without PowerShell', { skip: !makensis }, (t) => {
  const text = readFileSync(installerNsh, 'utf8');
  const macro = text.slice(text.indexOf('!macro customCheckAppRunning'), text.indexOf('!macroend', text.indexOf('!macro customCheckAppRunning')));
  assert.doesNotMatch(macro, /powershell/i);
  const result = runRunningCheck(`wf-nsh-none-${process.pid}.exe`);
  if (!result) { t.diagnostic('not run, Windows refused the stub'); return; }
  assert.equal(result.status, 0);
  assert.ok(result.ms < 3000, `the check itself took ${result.ms} ms`);
  t.diagnostic(`the check itself took ${result.ms} ms`);
});

test('the running check: a plain close request before /F, and an update first waits for the app to quit by itself', () => {
  const text = readFileSync(installerNsh, 'utf8');
  const macro = text.slice(text.indexOf('!macro customCheckAppRunning'), text.indexOf('!macroend', text.indexOf('!macro customCheckAppRunning')));
  assert.match(macro, /\$\{If\} \$\{isUpdated\}\s+StrCpy \$R2 6/, 'an update waits 6 passes (at least 3 s) before its first kill');
  assert.ok(macro.indexOf('taskkill /IM') < macro.indexOf('taskkill /F /IM'), 'the close request comes before the forced end');
  assert.match(macro, /\$\{AndIfNot\} \$\{isUpdated\}\s+\$\{AndIfNot\} \$\{Silent\}\s+StrCpy \$R0 cancel\s+MessageBox MB_OKCANCEL/, 'a run with a window asks once');
  const install = text.slice(text.indexOf('!macro customInstall'), text.indexOf('!macroend', text.indexOf('!macro customInstall')));
  assert.match(install, /\$\{AndIf\} \$installMode != "all"\s+Exec '"\$appExe" --updated'/, 'an elevated all-users installer never starts the app elevated');
});

/** A copied ping.exe under a throwaway image name runs while `check` runs; afterwards it must be gone. */
async function againstRunning(t: TestContext, tag: string, check: (image: string) => ReturnType<typeof runRunningCheck>) {
  const image = `wf-nsh-${tag}-${process.pid}.exe`;
  const copy = path.join(root, image);
  copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'PING.EXE'), copy);
  const child = spawn(copy, ['-n', '90', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
  const ended = new Promise<void>(resolve => child.once('exit', () => resolve()));
  await new Promise(resolve => setTimeout(resolve, 500));
  let result: ReturnType<typeof runRunningCheck> = null;
  let alive = '';
  try {
    result = check(image);
    alive = spawnSync('tasklist', ['/FI', `PID eq ${child.pid}`, '/NH'], { encoding: 'utf8' }).stdout;
  } finally { child.kill(); }
  await ended;
  if (!result) { t.diagnostic('not run, Windows refused the stub'); return null; }
  assert.equal(result.status, 0);
  assert.equal(alive.includes(image), false, 'taskkill ended it');
  t.diagnostic(`the check itself took ${result.ms} ms`);
  return result;
}

test('the running check ends a running process of this user with the app\'s image name', { skip: !makensis }, async (t) => {
  await againstRunning(t, 'ping', image => runRunningCheck(image));
});

test('the running check during an update gives the app at least 3 s to quit by itself before it ends it', { skip: !makensis }, async (t) => {
  const result = await againstRunning(t, 'upd', image => runRunningCheck(image, true));
  if (result) assert.ok(result.ms >= 3000, `waited ${result.ms} ms before the first kill`);
});
