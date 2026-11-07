// AF-014: the Windows Explorer's right-click entry "Create Autark agent from this folder" – on a folder and on a folder's
// empty background – registered for this user only (HKCU\Software\Classes\Directory\shell and …\Background\shell, no
// admin rights). The packaged app registers it at its first start and again when its own path changed (a state file
// in <userData> remembers the command, so a start costs one small read); the person removes it in the dialog ("Remove
// from Explorer"), which the state file remembers, and the uninstaller deletes both keys (assets/installer.nsh).
// The entry starts the app with `--agent-from-folder "<folder>"`: a running app gets it as a second instance and opens
// the "Agent from folder" dialog with that folder (index.ts → desktop.ts agentFromFolder → the renderer).
// Owns: the keys, the command line, the state file and reading the flag. Never: registers anything outside Windows or
// in an unpackaged development run unless asked, or touches HKLM.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { RunCommand } from './launcher-windows.ts';

export const MENU_NAME = 'AutarkAgentFromFolder';
export const MENU_LABEL = 'Create Autark agent from this folder';
export const FOLDER_FLAG = '--agent-from-folder';
export const MENU_KEYS = [`HKCU\\Software\\Classes\\Directory\\shell\\${MENU_NAME}`, `HKCU\\Software\\Classes\\Directory\\Background\\shell\\${MENU_NAME}`] as const;
const STATE_FILE = 'explorer-menu.json';

export interface MenuDeps {
  platform: NodeJS.Platform;
  /** The app's executable (process.execPath) and, unpackaged, the app folder Electron needs before the flag. */
  exe: string;
  prefix: readonly string[];
  run: RunCommand;
  /** <userData> – the state file's folder. */
  dir: string;
}

const quote = (value: string): string => `"${value.replace(/"/g, '')}"`;

/** The command line Explorer runs: `%1` is the clicked folder, `%V` the folder whose background was clicked. */
export function menuCommand(exe: string, prefix: readonly string[], placeholder: '%1' | '%V'): string {
  return [quote(exe), ...prefix.map(quote), FOLDER_FLAG, quote(placeholder)].join(' ');
}

/** reg.exe argument lists that write both entries (label, icon, command). */
export function registerCalls(exe: string, prefix: readonly string[]): string[][] {
  return MENU_KEYS.flatMap((key, index) => [
    ['add', key, '/ve', '/d', MENU_LABEL, '/f'],
    ['add', key, '/v', 'Icon', '/d', quote(exe), '/f'],
    ['add', `${key}\\command`, '/ve', '/d', menuCommand(exe, prefix, index === 0 ? '%1' : '%V'), '/f'],
  ]);
}

export function removeCalls(): string[][] {
  return MENU_KEYS.map((key) => ['delete', key, '/f']);
}

/** The folder a launch asks for (`--agent-from-folder <path>` or `--agent-from-folder=<path>`), if any. */
export function folderFromArgv(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === FOLDER_FLAG) return argv[i + 1]?.trim() || undefined;
    if (arg.startsWith(`${FOLDER_FLAG}=`)) return arg.slice(FOLDER_FLAG.length + 1).replace(/^"|"$/g, '').trim() || undefined;
  }
  return undefined;
}

interface MenuState { on: boolean; command?: string }

function readState(dir: string): MenuState | undefined {
  try {
    const value = JSON.parse(readFileSync(path.join(dir, STATE_FILE), 'utf8')) as Partial<MenuState>;
    return typeof value.on === 'boolean' ? { on: value.on, ...(typeof value.command === 'string' ? { command: value.command } : {}) } : undefined;
  } catch { return undefined; }
}

function writeState(dir: string, state: MenuState): void {
  try { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, STATE_FILE), `${JSON.stringify(state)}\n`); } catch { /* asked again next start */ }
}

/** Whether the entry is on (as this app last set it). */
export function menuOn(deps: Pick<MenuDeps, 'platform' | 'dir'>): boolean {
  return deps.platform === 'win32' && readState(deps.dir)?.on === true;
}

/** Writes or removes both entries; resolves whether it is on now. */
export async function setExplorerMenu(on: boolean, deps: MenuDeps): Promise<boolean> {
  if (deps.platform !== 'win32') return false;
  const calls = on ? registerCalls(deps.exe, deps.prefix) : removeCalls();
  let ok = true;
  for (const args of calls) {
    const result = await deps.run('reg', args);
    if (result.code !== 0 && on) ok = false; // a delete of a key that is not there fails harmlessly
  }
  writeState(deps.dir, { on: on && ok, ...(on && ok ? { command: menuCommand(deps.exe, deps.prefix, '%1') } : {}) });
  return on && ok;
}

/** The window's request (IPC, unchecked input): 'state', 'on' or 'off'; anything else answers the state. */
export async function explorerMenuAction(action: unknown, deps: MenuDeps): Promise<boolean> {
  if (action === 'on' || action === 'off') return setExplorerMenu(action === 'on', deps);
  return menuOn(deps);
}

/** At start (packaged, Windows): registers the entry unless the person removed it or it is current already. */
export async function ensureExplorerMenu(deps: MenuDeps & { packaged: boolean }): Promise<void> {
  if (deps.platform !== 'win32' || !deps.packaged) return;
  const state = readState(deps.dir);
  if (state?.on === false) return;
  if (state?.command === menuCommand(deps.exe, deps.prefix, '%1')) return;
  await setExplorerMenu(true, deps);
}
