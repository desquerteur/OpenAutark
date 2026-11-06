// "Keep agents running" (B-044, src/main/launcher-tasks.ts + launcher-windows.ts), the OS registrations with a fake command
// runner: Windows – ONE per-user Task Scheduler task (UTF-16 XML through schtasks /Create /XML) whose action
// is the app with --background --launcher (IgnoreNew), triggered at sign-in, 30 s after a crash or hang
// event naming the executable's full path, and – written only by a deliberate quit, only when it changed –
// at the next due work (next-due.json); the sign-in item of earlier versions removed; not created again
// while unchanged, again when the installation moved; removed when turned off (only when this installation
// registered it); on Windows also Task Scheduler's own validate-only check of both XML variants (nothing is
// registered). macOS – the LaunchAgent (KeepAlive on a failed exit, no periodic start); Linux – the
// autostart entry plus a systemd --user service and a timer that starts it once after sign-in. Nothing in
// development or test mode; a failing command is logged, never thrown. B-072: another company has its own of each,
// started with --company=<id>, and leaves the login item to the first company.
// Owns: these assertions only. Never: runs schtasks, launchctl or systemctl, registers a task or touches the real profile.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyLauncher, autostartFile, linuxAutostartEntry, linuxUnits, macLaunchAgent, type LauncherDeps } from '../../../src/main/launcher-tasks.ts';
import { CRASH_DELAY, armDueStart, crashQuery, windowsTaskName, windowsTaskXml } from '../../../src/main/launcher-windows.ts';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 25, 12, 0);
const EXE = 'C:\\Users\\Ann\\AppData\\Local\\Programs\\Workforce & Co\\Workforce.exe';
const TASK = 'Autark Launcher (Ann)';
const tmp = mkdtempSync(path.join(os.tmpdir(), 'wf-launcher-tasks-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const unxml = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function harness(platform: string, name: string, results: Record<string, number> = {}) {
  const calls: string[][] = [];
  const timeouts: Array<number | undefined> = [];
  const xmls: string[] = [];
  const set: unknown[] = [];
  const lines: string[] = [];
  let current = true; // an "Open at login" entry of an earlier version
  const root = path.join(tmp, name);
  const deps: LauncherDeps = {
    platform, packaged: true, testMode: false,
    getLoginItemSettings: () => ({ openAtLogin: current }),
    setLoginItemSettings: (settings) => { set.push(settings); current = settings.openAtLogin; },
    executable: platform === 'win32' ? EXE : '/opt/Work "force"/app $HOME',
    name: 'Autark', user: platform === 'win32' ? 'DESKTOP-1\\Ann' : 'ann', uid: 501,
    home: path.join(root, 'home'), configHome: path.join(root, 'config'), dataDir: path.join(root, 'data'),
    now: () => NOW,
    run: async (command, args, timeoutMs) => {
      calls.push([command, ...args]);
      timeouts.push(timeoutMs);
      const xml = args.indexOf('/XML');
      if (xml >= 0) xmls.push(readFileSync(args[xml + 1]).toString('utf16le'));
      return { code: results[`${command} ${args[0]}`] ?? 0, stdout: '', stderr: 'failed' };
    },
    log: (line) => lines.push(line),
  };
  const due = (at: number | null) => { mkdirSync(deps.dataDir, { recursive: true }); writeFileSync(path.join(deps.dataDir, 'next-due.json'), JSON.stringify({ at })); };
  const marker = () => JSON.parse(readFileSync(path.join(deps.dataDir, 'launcher.json'), 'utf8')) as { task: string; due: number | null };
  return { deps, calls, timeouts, xmls, set, lines, due, marker };
}

test('the Windows task XML: one task – sign-in, crash/hang events of this executable, the app itself with IgnoreNew', () => {
  const text = windowsTaskXml({ name: 'Autark', user: 'DESKTOP-1\\Ann', executable: 'C:\\Apps\\W & Co\\Workforce.exe' });
  assert.match(text, /^<\?xml version="1.0" encoding="UTF-16"\?>/);
  assert.match(text, /<Task version="1.2" xmlns="http:\/\/schemas.microsoft.com\/windows\/2004\/02\/mit\/task">/);
  assert.match(text, /<LogonTrigger><Enabled>true<\/Enabled><UserId>DESKTOP-1\\Ann<\/UserId><Delay>PT30S<\/Delay><\/LogonTrigger>/, 'only this user\'s sign-in (no admin)');
  const event = /<EventTrigger><Enabled>true<\/Enabled><Subscription>(.*)<\/Subscription><Delay>(.*)<\/Delay><\/EventTrigger>/.exec(text);
  assert.ok(event, text);
  assert.equal(event[2], CRASH_DELAY);
  const query = unxml(event[1]);
  assert.equal(query, crashQuery('C:\\Apps\\W & Co\\Workforce.exe'));
  assert.match(query, /^<QueryList><Query Id="0" Path="Application">.*<\/Query><\/QueryList>$/);
  const selects = [...query.matchAll(/<Select Path="Application">(.*?)<\/Select>/g)].map((match) => unxml(match[1]));
  assert.deepEqual(selects, [
    "*[System[Provider[@Name='Application Error'] and EventID=1000]] and *[EventData[Data='C:\\Apps\\W & Co\\Workforce.exe']]",
    "*[System[Provider[@Name='Application Hang'] and EventID=1002]] and *[EventData[Data='C:\\Apps\\W & Co\\Workforce.exe']]",
  ]);
  assert.match(unxml(crashQuery("C:\\Users\\O'Brien\\W.exe")), /Data="C:\\Users\\O'Brien\\W\.exe"/, 'an apostrophe in the path: the other quote');
  assert.doesNotMatch(text, /<TimeTrigger>|<Repetition>|powershell|launcher-check/i, 'no time trigger outside a quit, no periodic start, no script');
  assert.match(text, /<Principal id="Author"><UserId>DESKTOP-1\\Ann<\/UserId><LogonType>InteractiveToken<\/LogonType><RunLevel>LeastPrivilege<\/RunLevel><\/Principal>/);
  for (const setting of ['<MultipleInstancesPolicy>IgnoreNew<', '<DisallowStartIfOnBatteries>false<', '<StopIfGoingOnBatteries>false<', '<StartWhenAvailable>true<',
    '<WakeToRun>false<', '<Hidden>false<', '<ExecutionTimeLimit>PT5M<', '<Priority>5<']) assert.ok(text.includes(setting), setting);
  const action = /<Exec><Command>(.*)<\/Command><Arguments>(.*)<\/Arguments><WorkingDirectory>(.*)<\/WorkingDirectory><\/Exec>/.exec(text);
  assert.ok(action, text);
  assert.deepEqual([action[1], action[2], action[3]], ['C:\\Apps\\W &amp; Co\\Workforce.exe', '--background --launcher', 'C:\\Apps\\W &amp; Co'], 'the app itself');
  const due = windowsTaskXml({ name: 'W', user: 'DESKTOP-1\\Ann', executable: 'C:\\W.exe', due: NOW + 90 * MIN + 1234 });
  assert.match(due, /<TimeTrigger><Enabled>true<\/Enabled><StartBoundary>2026-10-25T13:30:01Z<\/StartBoundary><\/TimeTrigger>\r\n {2}<\/Triggers>/, 'UTC, whole seconds, last');
  assert.equal(windowsTaskName('Autark', 'DESKTOP-1\\Ann'), TASK);
});

test('Task Scheduler accepts both variants (validate only – nothing is registered)', { skip: process.platform !== 'win32' }, () => {
  const user = `${process.env.USERDOMAIN ?? ''}\\${process.env.USERNAME ?? ''}`;
  const dir = path.join(tmp, 'validate');
  mkdirSync(dir, { recursive: true });
  const files = [null, NOW + 365 * 24 * 60 * MIN].map((due, index) => {
    const file = path.join(dir, `task-${index}.xml`);
    writeFileSync(file, windowsTaskXml({ name: 'Autark', user, executable: "C:\\Programs\\W & O'Co\\Workforce.exe", due }), 'utf8');
    return file;
  });
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$service = New-Object -ComObject Schedule.Service; $service.Connect(); $folder = $service.GetFolder("\\")',
    // TASK_VALIDATE_ONLY (1): the service checks the XML and registers nothing; 3 = TASK_LOGON_INTERACTIVE_TOKEN
    ...files.map((file) => `$null = $folder.RegisterTask('Workforce XML check', [IO.File]::ReadAllText('${file.replace(/'/g, "''")}'), 1, $null, $null, 3, $null); 'valid'`),
  ].join('\n');
  const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const out = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.deepEqual(out.trim().split(/\r?\n/), ['valid', 'valid']);
});

test('Windows: one task, created once, again when the installation moved, the old sign-in item removed, removed when turned off', async () => {
  const h = harness('win32', 'win');
  await applyLauncher(true, h.deps);
  assert.deepEqual(h.set, [{ openAtLogin: false, args: ['--background'] }], 'the task signs in now');
  assert.deepEqual(h.calls.map((call) => call.slice(0, 4)), [['schtasks', '/Create', '/TN', TASK]]);
  assert.deepEqual(h.calls[0].slice(4), ['/XML', path.join(h.deps.dataDir, 'tmp', 'launcher-task.xml'), '/F']);
  assert.match(h.xmls[0], /^\uFEFF<\?xml/, 'UTF-16 with BOM');
  assert.doesNotMatch(h.xmls[0], /<TimeTrigger>/, 'a start writes no time trigger');
  assert.ok(!existsSync(path.join(h.deps.dataDir, 'tmp', 'launcher-task.xml')), 'the XML file is removed');
  assert.deepEqual([h.marker().task, h.marker().due], [TASK, null]);
  await applyLauncher(true, h.deps);
  assert.deepEqual(h.calls.slice(1), [['schtasks', '/Query', '/TN', TASK]], 'unchanged and present: only a query');
  assert.equal(h.set.length, 1);
  await applyLauncher(true, { ...h.deps, executable: 'D:\\Other\\Workforce.exe' });
  assert.equal(h.calls.filter((call) => call[1] === '/Create').length, 2, 'a moved installation registers again');
  assert.match(h.xmls[1], /<Command>D:\\Other\\Workforce\.exe<\/Command>/);
  await applyLauncher(false, h.deps);
  assert.deepEqual(h.calls.at(-1), ['schtasks', '/Delete', '/TN', TASK, '/F']);
  assert.ok(!existsSync(path.join(h.deps.dataDir, 'launcher.json')));
  const count = h.calls.length;
  await applyLauncher(false, h.deps);
  assert.equal(h.calls.length, count, 'never registered here: no schtasks process at every start');
  assert.deepEqual(h.lines, []);
});

test('Windows: a deliberate quit writes the one time trigger at the next due work – only when that time changed', async () => {
  const h = harness('win32', 'win-due');
  await applyLauncher(true, h.deps);
  const creates = () => h.calls.filter((call) => call[1] === '/Create').length;
  h.due(NOW + 120 * MIN);
  await armDueStart(true, 'person', h.deps);
  assert.equal(creates(), 2);
  assert.match(h.xmls[1], /<StartBoundary>2026-10-25T14:00:00Z<\/StartBoundary>/);
  assert.equal(h.timeouts.at(-1), 5000, 'a quit waits at most 5 s');
  assert.equal(h.marker().due, NOW + 120 * MIN);
  await armDueStart(true, 'update', h.deps);
  assert.equal(creates(), 2, 'the same time: no schtasks process');
  await applyLauncher(true, h.deps);
  assert.equal(creates(), 2, 'the next start keeps it (only a query)');
  h.due(NOW + 30 * 1000);
  await armDueStart(true, 'person', h.deps);
  assert.match(h.xmls.at(-1)!, /<StartBoundary>2026-10-25T12:01:00Z<\/StartBoundary>/, 'due within the minute: one minute after the quit');
  h.due(null);
  await armDueStart(true, 'person', h.deps);
  assert.doesNotMatch(h.xmls.at(-1)!, /<TimeTrigger>/, 'nothing due: the old time trigger goes');
  const before = creates();
  h.due(NOW - 60 * MIN);
  await armDueStart(true, 'person', h.deps);
  assert.equal(creates(), before, 'overdue work waits for the next start (no trigger, unchanged)');
  h.due(NOW + 240 * MIN);
  for (const [enabled, by, patch] of [[true, 'system', {}], [true, undefined, {}], [false, 'person', {}], [true, 'person', { packaged: false }],
    [true, 'person', { testMode: true }], [true, 'person', { platform: 'darwin' }]] as const) await armDueStart(enabled, by, { ...h.deps, ...patch });
  assert.equal(creates(), before, 'no due start for an ending session, when turned off, in development, test mode or elsewhere');
  const failing = harness('win32', 'win-due-fail', { 'schtasks /Create': 1 });
  failing.due(NOW + 120 * MIN);
  await armDueStart(true, 'person', failing.deps);
  assert.match(failing.lines[0], /launcher task not created: failed/);
  assert.ok(!existsSync(path.join(failing.deps.dataDir, 'launcher.json')), 'not recorded: the next quit tries again');
});

test('Windows: a refused task is logged and retried at the next start; development and test mode register nothing', async () => {
  const h = harness('win32', 'win-fail', { 'schtasks /Create': 1 });
  await applyLauncher(true, h.deps);
  assert.match(h.lines[0], /launcher task not created: failed/);
  assert.ok(!existsSync(path.join(h.deps.dataDir, 'launcher.json')));
  const dev = harness('win32', 'win-dev');
  await applyLauncher(true, { ...dev.deps, packaged: false });
  await applyLauncher(true, { ...dev.deps, testMode: true });
  assert.deepEqual([dev.calls, dev.set], [[], []], 'never registers electron.exe');
});

test('macOS: the login item plus a LaunchAgent (KeepAlive on a failed exit, no periodic start) through launchctl', async () => {
  const plist = macLaunchAgent({ executable: '/Applications/W.app/Contents/MacOS/W' });
  assert.match(plist, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.doesNotMatch(plist, /StartCalendarInterval|StartInterval/);
  assert.match(plist, /<string>--background<\/string><string>--launcher<\/string>/);
  const h = harness('darwin', 'mac');
  await applyLauncher(true, h.deps);
  assert.deepEqual(h.set, [], 'the login item is already on');
  const file = path.join(h.deps.home, 'Library', 'LaunchAgents', 'com.teydralab.workforce.launcher.plist');
  assert.ok(readFileSync(file, 'utf8').includes('&quot;force&quot;'), 'the path is escaped');
  assert.deepEqual(h.calls, [['launchctl', 'bootout', 'gui/501/com.teydralab.workforce.launcher'], ['launchctl', 'bootstrap', 'gui/501', file]]);
  await applyLauncher(true, h.deps);
  assert.equal(h.calls.length, 2, 'unchanged: not loaded again');
  await applyLauncher(false, h.deps);
  assert.deepEqual(h.set, [{ openAtLogin: false }], 'no arguments on macOS');
  assert.ok(!existsSync(file));
  assert.deepEqual(h.calls.at(-1), ['launchctl', 'bootout', 'gui/501/com.teydralab.workforce.launcher']);
});

test('Linux: the autostart entry plus a systemd user service (restart on failure) and a timer that starts it once after sign-in', async () => {
  const units = linuxUnits({ name: 'Autark', executable: '/opt/a b/app%1' });
  assert.match(units.service, /^ExecStart="\/opt\/a b\/app%%1" --background --launcher$/m);
  assert.match(units.service, /^Restart=on-failure$/m);
  assert.match(units.timer, /^OnStartupSec=2min$/m);
  assert.doesNotMatch(units.timer, /OnUnitInactiveSec|OnCalendar/, 'no periodic start');
  assert.equal(units.timerName, 'autark-launcher.timer');
  const h = harness('linux', 'linux');
  await applyLauncher(true, h.deps);
  const entry = readFileSync(autostartFile(h.deps.configHome, h.deps.name), 'utf8');
  assert.match(entry, /^Exec="\/opt\/Work \\"force\\"\/app \\\$HOME" --background$/m);
  assert.match(linuxAutostartEntry({ name: 'A\nB', executable: '/x' }), /^Name=A B$/m);
  assert.deepEqual(h.calls, [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', 'autark-launcher.timer']]);
  await applyLauncher(false, h.deps);
  assert.ok(!existsSync(autostartFile(h.deps.configHome, h.deps.name)));
  assert.ok(!existsSync(path.join(h.deps.configHome, 'systemd', 'user', units.timerName)));
  const plain = harness('linux', 'no-systemd', { 'systemctl --user': 1 });
  await applyLauncher(true, plain.deps);
  assert.match(plain.lines[0], /no systemd user session/);
  assert.ok(existsSync(autostartFile(plain.deps.configHome, plain.deps.name)), 'the sign-in start still works');
});

test('B-072: another company keeps its own task, LaunchAgent, units and entry, started with --company=<id>; the first stays as it was', async () => {
  const xml = windowsTaskXml({ name: 'Autark company-2', user: 'DESKTOP-1\\Ann', executable: 'C:\\W.exe', company: 'company-2' });
  assert.match(xml, /<Arguments>--background --launcher --company=company-2<\/Arguments>/);
  assert.equal(windowsTaskName('Autark company-2', 'DESKTOP-1\\Ann'), 'Autark company-2 Launcher (Ann)');
  assert.match(windowsTaskXml({ name: 'Autark', user: 'DESKTOP-1\\Ann', executable: 'C:\\W.exe', company: null }), /<Arguments>--background --launcher<\/Arguments>/);
  const win = harness('win32', 'win-company');
  const deps = { ...win.deps, name: 'Autark company-2', company: 'company-2' };
  await applyLauncher(true, deps);
  assert.deepEqual(win.set, [], 'the old sign-in item is the first company\'s');
  assert.deepEqual(win.calls[0].slice(0, 4), ['schtasks', '/Create', '/TN', 'Autark company-2 Launcher (Ann)']);
  assert.match(win.xmls[0], /--company=company-2/);
  await applyLauncher(false, deps);
  assert.deepEqual(win.calls.at(-1), ['schtasks', '/Delete', '/TN', 'Autark company-2 Launcher (Ann)', '/F'], 'only its own task goes');

  assert.match(macLaunchAgent({ executable: '/A', company: 'company-2' }), /<key>Label<\/key><string>com\.teydralab\.workforce\.launcher\.company-2<\/string>[\s\S]*<string>--background<\/string><string>--launcher<\/string><string>--company=company-2<\/string>/);
  const mac = harness('darwin', 'mac-company');
  await applyLauncher(true, { ...mac.deps, name: 'Autark company-2', company: 'company-2' });
  assert.deepEqual(mac.set, [], 'the login item (no arguments) is the first company\'s');
  assert.ok(existsSync(path.join(mac.deps.home, 'Library', 'LaunchAgents', 'com.teydralab.workforce.launcher.company-2.plist')));
  assert.deepEqual(mac.calls.at(-1)!.slice(0, 2), ['launchctl', 'bootstrap']);

  const units = linuxUnits({ name: 'Autark company-2', executable: '/opt/a', company: 'company-2' });
  assert.equal(units.timerName, 'autark-company-2-launcher.timer');
  assert.match(units.service, /^ExecStart="\/opt\/a" --background --launcher --company=company-2$/m);
  assert.match(linuxAutostartEntry({ name: 'Autark company-2', executable: '/opt/a', company: 'company-2' }), /^Exec="\/opt\/a" --background --company=company-2$/m);
  assert.equal(path.basename(autostartFile('/cfg', 'Autark company-2')), 'autark-company-2.desktop');
});
