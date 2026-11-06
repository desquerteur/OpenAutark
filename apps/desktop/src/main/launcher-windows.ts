// "Keep agents running" (B-044), the Windows task: ONE per-user Task Scheduler task (schtasks /Create /XML,
// no admin) whose action is `<exe> --background --launcher` (launcher.ts decides at once, before the app's
// main code loads; a start that goes on hands over to a detached ordinary start), MultipleInstancesPolicy
// IgnoreNew, triggers: at the person's sign-in; 30 s after a crash ('Application Error' 1000) or hang
// ('Application Hang' 1002) in the Application log whose event data names this executable's full path; and
// one time trigger at the next due work – written only on a deliberate quit from next-due.json
// (`armDueStart`: no schtasks call per re-arm of the scheduler, none when that time is unchanged). Only
// while signed in (InteractiveToken, LeastPrivilege), battery allowed, a missed due start runs when the PC
// is back, normal priority. Schema facts (learn.microsoft.com, Task Scheduler schema 1.2): trigger children
// in sequence Enabled, StartBoundary, …, then LogonTrigger UserId/Delay, EventTrigger Subscription (an
// escaped QueryList string)/Delay; Settings in any order; StartBoundary with "Z" is UTC.
// <userData>/launcher.json records what was registered (the definition's hash without the time trigger,
// and that trigger's time); the uninstaller removes the task (assets/installer.nsh). B-072: another company has a task
// of its own ("<name> <id> Launcher (<user>)", launcher-tasks.ts names it) that starts it with --company=<id>.
// Owns: the task XML, its registration and launcher.json. Never: decides a launch (launcher.ts) or throws
// out of armDueStart.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { QuitBy } from '../shared/model/launch.ts';
import { companyArgs } from './companies.ts';
import { BACKGROUND_FLAG, LAUNCHER_FLAG, readNextDue } from './launcher.ts';

export const CRASH_DELAY = 'PT30S'; // the crashed process (and its single-instance lock) is gone by then
export const SIGNIN_DELAY = 'PT30S'; // after the sign-in burst
const MIN_LEAD_MS = 60_000; // a due time within the next minute starts it one minute after the quit
const QUIT_TIMEOUT_MS = 5000;

export type RunCommand = (command: string, args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface WindowsTaskDeps {
  platform: string;
  packaged: boolean;
  testMode: boolean;
  executable: string; // process.execPath
  name: string; // product name (another company's: "<product name> <id>")
  company?: string | null; // B-072: another company's id; its starts carry --company=<id>
  user: string; // DOMAIN\user
  dataDir: string; // userData: the XML is written to <data>/tmp, what was registered to <data>/launcher.json
  run: RunCommand;
  now?(): number;
  log?(line: string): void;
}

const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** The per-user task's name (two Windows users on one PC each get their own). */
export function windowsTaskName(name: string, user: string): string {
  const who = user.split('\\').pop()!.replace(/[\\/:*?"<>|]/g, '');
  return `${name} Launcher (${who || 'user'})`;
}

/** The event query: a crash or hang of this executable (its full path; the comparison ignores case). */
export function crashQuery(executable: string): string {
  const literal = executable.includes("'") ? `"${executable}"` : `'${executable}'`; // a Windows path never holds "
  const select = (provider: string, id: number) =>
    `<Select Path="Application">${xml(`*[System[Provider[@Name='${provider}'] and EventID=${id}]] and *[EventData[Data=${literal}]]`)}</Select>`;
  return `<QueryList><Query Id="0" Path="Application">${select('Application Error', 1000)}${select('Application Hang', 1002)}</Query></QueryList>`;
}

/** A UTC start boundary ("Z": the time holds regardless of the zone and daylight saving). */
const utcBoundary = (at: number) => new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** What a launcher start runs with: `--background --launcher`, and another company's flag. */
export function launcherArgs(company?: string | null): string[] {
  return [BACKGROUND_FLAG, LAUNCHER_FLAG, ...companyArgs(company)];
}

/** The task XML; `due`: the one time trigger (a deliberate quit only). */
export function windowsTaskXml(input: { name: string; user: string; executable: string; company?: string | null; due?: number | null }): string {
  const due = typeof input.due === 'number' ? input.due : null;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    `  <RegistrationInfo><Description>${xml(`${input.name}: keeps agents running – starts it at sign-in, after an unexpected close and for scheduled work.`)}</Description></RegistrationInfo>`,
    '  <Triggers>',
    `    <LogonTrigger><Enabled>true</Enabled><UserId>${xml(input.user)}</UserId><Delay>${SIGNIN_DELAY}</Delay></LogonTrigger>`,
    `    <EventTrigger><Enabled>true</Enabled><Subscription>${xml(crashQuery(input.executable))}</Subscription><Delay>${CRASH_DELAY}</Delay></EventTrigger>`,
    ...(due === null ? [] : [`    <TimeTrigger><Enabled>true</Enabled><StartBoundary>${utcBoundary(due)}</StartBoundary></TimeTrigger>`]),
    '  </Triggers>',
    `  <Principals><Principal id="Author"><UserId>${xml(input.user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>', // a due start missed while the PC slept or was off
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>', // the task's process decides in moments (the app runs detached)
    '    <Priority>5</Priority>', // normal; the detached app inherits it (the default 7 means low I/O and memory priority)
    '  </Settings>',
    '  <Actions Context="Author">',
    `    <Exec><Command>${xml(input.executable)}</Command><Arguments>${launcherArgs(input.company).join(' ')}</Arguments><WorkingDirectory>${xml(path.win32.dirname(input.executable))}</WorkingDirectory></Exec>`,
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

interface Registered { hash: string; due: number | null }

const markerFile = (deps: WindowsTaskDeps) => path.join(deps.dataDir, 'launcher.json');
/** The task's identity without its time trigger: a moved installation or a new definition differs. */
const baseHash = (deps: WindowsTaskDeps) => createHash('sha256').update(windowsTaskXml({ ...deps, due: null })).digest('hex').slice(0, 16);

/** What this installation registered (undefined: nothing; an unreadable file still counts as registered). */
async function readRegistered(deps: WindowsTaskDeps): Promise<Registered | undefined> {
  let text: string;
  try { text = await readFile(markerFile(deps), 'utf8'); } catch { return undefined; }
  try {
    const value = JSON.parse(text) as { hash?: unknown; due?: unknown };
    return { hash: typeof value.hash === 'string' ? value.hash : '', due: typeof value.due === 'number' ? value.due : null };
  } catch {
    return { hash: '', due: null };
  }
}

async function registerTask(deps: WindowsTaskDeps, due: number | null, timeoutMs?: number): Promise<void> {
  const name = windowsTaskName(deps.name, deps.user);
  const file = path.join(deps.dataDir, 'tmp', 'launcher-task.xml');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(windowsTaskXml({ ...deps, due }), 'utf16le')])); // schtasks reads UTF-16 with BOM
  try {
    const result = await deps.run('schtasks', ['/Create', '/TN', name, '/XML', file, '/F'], timeoutMs);
    if (result.code !== 0) { deps.log?.(`launcher task not created: ${result.stderr.trim() || result.stdout.trim()}`); return; }
    await writeFile(markerFile(deps), `${JSON.stringify({ task: name, hash: baseHash(deps), due })}\n`);
  } finally {
    await rm(file, { force: true });
  }
}

/** Applies the preference at start (launcher-tasks.ts): registered once, again when the definition changed, removed when off. */
export async function windowsTask(enabled: boolean, deps: WindowsTaskDeps): Promise<void> {
  const name = windowsTaskName(deps.name, deps.user);
  const stored = await readRegistered(deps);
  if (!enabled) {
    if (stored === undefined) return; // never registered by this installation: nothing to remove (no process per start)
    const result = await deps.run('schtasks', ['/Delete', '/TN', name, '/F']);
    if (result.code !== 0 && (await deps.run('schtasks', ['/Query', '/TN', name])).code === 0) { deps.log?.(`launcher task not removed: ${result.stderr.trim()}`); return; }
    await rm(markerFile(deps), { force: true });
    return;
  }
  if (stored?.hash === baseHash(deps) && (await deps.run('schtasks', ['/Query', '/TN', name])).code === 0) return;
  await registerTask(deps, null); // a time trigger is only written by a deliberate quit
}

/**
 * A deliberate quit (the person's or an update's; not the system ending the session): the task's one time
 * trigger at the runtime's next due work (next-due.json, settled at runtime stop) – a schtasks process only
 * when that time changed; overdue work waits for the next start. Never throws.
 */
export async function armDueStart(enabled: boolean, by: QuitBy | undefined, deps: WindowsTaskDeps): Promise<void> {
  if (!enabled || (by !== 'person' && by !== 'update') || deps.platform !== 'win32' || !deps.packaged || deps.testMode) return;
  try {
    const now = deps.now?.() ?? Date.now();
    const next = readNextDue(deps.dataDir);
    const due = typeof next === 'number' && next > now ? Math.max(next, now + MIN_LEAD_MS) : null;
    const stored = await readRegistered(deps);
    if (stored && stored.hash === baseHash(deps) && stored.due === due) return;
    await registerTask(deps, due, QUIT_TIMEOUT_MS);
  } catch (error) {
    deps.log?.(`launcher due start not written: ${(error as Error)?.message ?? 'error'}`);
  }
}
