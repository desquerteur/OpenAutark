// "Keep agents running" (B-044, preferences.openAtLogin), the OS side – replaces "Open at login", no
// polling and no periodic starts:
//  * Windows: ONE per-user Task Scheduler task – sign-in, a crash or hang of the app, the next due work
//    after a deliberate quit (launcher-windows.ts); the sign-in item of earlier versions is removed;
//  * macOS: the login item plus a LaunchAgent (KeepAlive {SuccessfulExit: false}: started at sign-in,
//    restarted when it exits with an error); Linux: an XDG autostart entry plus a systemd --user service
//    (Restart=on-failure) and a timer that starts it once after sign-in. Both start `--background --launcher`
//    (launcher.ts decides at once).
// Only in packaged builds outside test mode (it would register electron.exe); turning the preference off
// removes all of it; an unchanged registration is not written again. Never throws (logged). B-072: another company
// registers its own task, LaunchAgent, units and autostart entry ("<name> <id>", with --company=<id>); the login
// item and the old sign-in item stay the first company's.
// Owns: applying the preference, the macOS/Linux unit texts and the login item. Never: decides a launch
// (launcher.ts) or imports electron at runtime (types only).

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { App } from 'electron';
import { companyArgs } from './companies.ts';
import { BACKGROUND_FLAG } from './launcher.ts';
import { launcherArgs, windowsTask, type RunCommand, type WindowsTaskDeps } from './launcher-windows.ts';

export const MAC_LABEL = 'com.teydralab.workforce.launcher';
/** The LaunchAgent's label (another company: with its id). */
export const macLabel = (company?: string | null) => (company ? `${MAC_LABEL}.${company}` : MAC_LABEL);

export interface LauncherDeps extends WindowsTaskDeps {
  getLoginItemSettings(options?: { args?: string[] }): { openAtLogin: boolean };
  setLoginItemSettings(settings: { openAtLogin: boolean; args?: string[] }): void;
  executable: string; // the binary to start (APPIMAGE when running as AppImage, else process.execPath)
  user: string; // Windows: DOMAIN\user; elsewhere the user name
  uid: number; // macOS launchctl domain
  home: string;
  configHome: string; // $XDG_CONFIG_HOME or ~/.config
}

const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workforce';

/** The LaunchAgent: started at sign-in (KeepAlive implies RunAtLoad) and restarted after a failed exit. */
export function macLaunchAgent(input: { executable: string; company?: string | null }): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${macLabel(input.company)}</string>`,
    '  <key>ProgramArguments</key>',
    `  <array>${[input.executable, ...launcherArgs(input.company)].map(arg => `<string>${xml(arg)}</string>`).join('')}</array>`,
    '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    '  <key>ThrottleInterval</key><integer>30</integer>',
    '  <key>LimitLoadToSessionType</key><string>Aqua</string>',
    '  <key>ProcessType</key><string>Interactive</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** systemd `ExecStart` quoting: double quotes, escaped \ " and %. */
function quoteUnit(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

export function linuxUnits(input: { name: string; executable: string; company?: string | null }): { service: string; timer: string; serviceName: string; timerName: string } {
  const base = `${slug(input.name)}-launcher`;
  const name = input.name.replace(/[\r\n]/g, ' ');
  return {
    serviceName: `${base}.service`,
    timerName: `${base}.timer`,
    service: ['[Unit]', `Description=${name}: keep agents running`, '', '[Service]', 'Type=simple',
      `ExecStart=${quoteUnit(input.executable)} ${launcherArgs(input.company).join(' ')}`, 'Restart=on-failure', 'RestartSec=30', ''].join('\n'),
    timer: ['[Unit]', `Description=${name}: start after sign-in`, '', '[Timer]', 'OnStartupSec=2min',
      `Unit=${base}.service`, '', '[Install]', 'WantedBy=timers.target', ''].join('\n'),
  };
}

/** Desktop Entry `Exec` quoting (spec: quote, escape " ` $ \). */
function quoteExec(value: string): string {
  return `"${value.replace(/(["`$\\])/g, '\\$1')}"`;
}

export function linuxAutostartEntry(input: { name: string; executable: string; company?: string | null }): string {
  const name = input.name.replace(/[\r\n]/g, ' ');
  const args = [BACKGROUND_FLAG, ...companyArgs(input.company)].join(' ');
  return ['[Desktop Entry]', 'Type=Application', `Name=${name}`, `Exec=${quoteExec(input.executable)} ${args}`, 'Terminal=false', 'X-GNOME-Autostart-enabled=true', ''].join('\n');
}

export function autostartFile(configHome: string, name: string): string {
  return path.join(configHome, 'autostart', `${slug(name)}.desktop`);
}

async function readText(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); } catch { return undefined; }
}

/** Writes `text` unless the file already holds it; true when it changed. */
async function ensureFile(file: string, text: string): Promise<boolean> {
  if (await readText(file) === text) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, { mode: 0o644 });
  return true;
}

async function macAgent(enabled: boolean, deps: LauncherDeps): Promise<void> {
  const label = macLabel(deps.company);
  const file = path.join(deps.home, 'Library', 'LaunchAgents', `${label}.plist`);
  const domain = `gui/${deps.uid}`;
  if (!enabled) {
    if (await readText(file) === undefined) return;
    await deps.run('launchctl', ['bootout', `${domain}/${label}`]);
    await rm(file, { force: true });
    return;
  }
  if (!await ensureFile(file, macLaunchAgent({ executable: deps.executable, company: deps.company }))) return;
  await deps.run('launchctl', ['bootout', `${domain}/${label}`]); // an older definition (fails when none is loaded)
  const result = await deps.run('launchctl', ['bootstrap', domain, file]);
  if (result.code !== 0) deps.log?.(`launch agent not loaded: ${result.stderr.trim()}`);
}

async function linuxTimer(enabled: boolean, deps: LauncherDeps): Promise<void> {
  const units = linuxUnits(deps);
  const dir = path.join(deps.configHome, 'systemd', 'user');
  if (!enabled) {
    if (await readText(path.join(dir, units.timerName)) === undefined) return;
    await deps.run('systemctl', ['--user', 'disable', '--now', units.timerName]);
    await rm(path.join(dir, units.timerName), { force: true });
    await rm(path.join(dir, units.serviceName), { force: true });
    await deps.run('systemctl', ['--user', 'daemon-reload']);
    return;
  }
  const changed = [await ensureFile(path.join(dir, units.serviceName), units.service), await ensureFile(path.join(dir, units.timerName), units.timer)].some(Boolean);
  if (!changed) return;
  const reload = await deps.run('systemctl', ['--user', 'daemon-reload']);
  if (reload.code !== 0) { deps.log?.('no systemd user session: the app starts at sign-in only'); return; }
  const result = await deps.run('systemctl', ['--user', 'enable', '--now', units.timerName]);
  if (result.code !== 0) deps.log?.(`launcher timer not enabled: ${result.stderr.trim()}`);
}

async function loginItem(enabled: boolean, deps: LauncherDeps): Promise<void> {
  if (deps.platform === 'linux') {
    const file = autostartFile(deps.configHome, deps.name);
    if (enabled) await ensureFile(file, linuxAutostartEntry(deps));
    else await rm(file, { force: true });
    return;
  }
  if (deps.company) return; // the login item (no arguments) and the old sign-in item are the first company's
  if (deps.platform === 'win32') { // the task's sign-in trigger replaces the sign-in item of earlier versions
    const args = [BACKGROUND_FLAG];
    if (deps.getLoginItemSettings({ args }).openAtLogin) deps.setLoginItemSettings({ openAtLogin: false, args });
    return;
  }
  // macOS login items cannot carry arguments; a sign-in start there opens the window.
  if (deps.getLoginItemSettings().openAtLogin !== enabled) deps.setLoginItemSettings({ openAtLogin: enabled });
}

/** Applies the preference; idempotent and never throws (each part is logged on its own). */
export async function applyLauncher(enabled: boolean, deps: LauncherDeps): Promise<void> {
  if (!deps.packaged || deps.testMode) return;
  const parts: Array<[string, () => Promise<void>]> = [['login item', () => loginItem(enabled, deps)]];
  if (deps.platform === 'win32') parts.push(['task', () => windowsTask(enabled, deps)]);
  else if (deps.platform === 'darwin') parts.push(['launch agent', () => macAgent(enabled, deps)]);
  else if (deps.platform === 'linux') parts.push(['timer', () => linuxTimer(enabled, deps)]);
  for (const [part, apply] of parts) {
    try { await apply(); } catch (error) { deps.log?.(`launcher ${part} not updated: ${(error as Error)?.message ?? 'error'}`); }
  }
}

/** Runs a command without a window or shell (15 s limit unless given); never rejects. */
export const runCommand: RunCommand = (command, args, timeoutMs = 15_000) => new Promise((resolve) => {
  execFile(command, args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
    resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
});

/** Deps from Electron's app object and the process. */
export function launcherDeps(app: App, input: { platform: string; testMode: boolean; name: string; company?: string | null; dataDir: string; log?(line: string): void }): LauncherDeps {
  const info = os.userInfo();
  const user = input.platform === 'win32' && process.env.USERNAME ? `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ''}${process.env.USERNAME}` : info.username;
  return {
    platform: input.platform,
    packaged: app.isPackaged,
    testMode: input.testMode,
    getLoginItemSettings: (options) => app.getLoginItemSettings(options),
    setLoginItemSettings: (settings) => app.setLoginItemSettings(settings),
    executable: process.env.APPIMAGE || process.execPath,
    name: input.company ? `${input.name} ${input.company}` : input.name, // B-072: a task, unit and entry of its own
    company: input.company ?? null,
    user,
    uid: info.uid,
    home: os.homedir(),
    configHome: process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    dataDir: input.dataDir,
    run: runCommand,
    log: input.log,
  };
}
