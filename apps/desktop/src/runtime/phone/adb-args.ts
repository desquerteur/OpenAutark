// Argument building for phone use over ADB (moved out of adb.ts by PH2, re-exported there):
// quoting for the phone's /system/bin/sh, text for `input text`, the key allow-list, and the
// places adb is looked for (Android SDK and winget folders).
// Owns: those pure helpers. Never: runs adb (adb.ts) or sends keys that lock or power off the phone.

import path from 'node:path';
import { WorkforceError } from '../../shared/errors.ts';

export const KEYS: Record<string, string> = {
  back: 'KEYCODE_BACK', home: 'KEYCODE_HOME', recents: 'KEYCODE_APP_SWITCH', app_switch: 'KEYCODE_APP_SWITCH', enter: 'KEYCODE_ENTER',
  delete: 'KEYCODE_DEL', backspace: 'KEYCODE_DEL', del: 'KEYCODE_DEL', forward_delete: 'KEYCODE_FORWARD_DEL', tab: 'KEYCODE_TAB',
  escape: 'KEYCODE_ESCAPE', esc: 'KEYCODE_ESCAPE', space: 'KEYCODE_SPACE', up: 'KEYCODE_DPAD_UP', down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT', right: 'KEYCODE_DPAD_RIGHT', center: 'KEYCODE_DPAD_CENTER', menu: 'KEYCODE_MENU', search: 'KEYCODE_SEARCH',
  volume_up: 'KEYCODE_VOLUME_UP', volume_down: 'KEYCODE_VOLUME_DOWN', page_up: 'KEYCODE_PAGE_UP', page_down: 'KEYCODE_PAGE_DOWN',
  move_home: 'KEYCODE_MOVE_HOME', move_end: 'KEYCODE_MOVE_END', wakeup: 'KEYCODE_WAKEUP',
};
const ALLOWED_KEYCODES = new Set(Object.values(KEYS));

/** Keys that only move, switch or wake – they confirm, delete or type nothing in the focused element. */
const MOVING_KEYCODES = new Set([
  'KEYCODE_BACK', 'KEYCODE_HOME', 'KEYCODE_APP_SWITCH', 'KEYCODE_TAB', 'KEYCODE_ESCAPE', 'KEYCODE_DPAD_UP', 'KEYCODE_DPAD_DOWN',
  'KEYCODE_DPAD_LEFT', 'KEYCODE_DPAD_RIGHT', 'KEYCODE_PAGE_UP', 'KEYCODE_PAGE_DOWN', 'KEYCODE_MOVE_HOME', 'KEYCODE_MOVE_END',
  'KEYCODE_WAKEUP', 'KEYCODE_VOLUME_UP', 'KEYCODE_VOLUME_DOWN',
]);

/** Quotes one argument for the phone's /system/bin/sh (adb shell joins arguments with spaces). */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Text for `input text`: spaces become %s; only printable ASCII is supported by `input`. */
export function inputText(value: string): string {
  if (!/^[\x20-\x7e]*$/.test(value)) throw new WorkforceError('bad_request', 'Phone typing over ADB supports plain ASCII text only. Type other characters in smaller ASCII parts or pick suggestions on the phone.');
  return shQuote(value.replace(/ /g, '%s'));
}

/** Key name ("back", "enter", "KEYCODE_HOME") → an allowed Android keycode. */
export function keycode(name: string): string {
  const raw = name.trim();
  const mapped = KEYS[raw.toLowerCase()] ?? raw.toUpperCase();
  if (!ALLOWED_KEYCODES.has(mapped)) throw new WorkforceError('bad_request', `Key "${name}" is not one of the keys this tool sends. Keys: ${Object.keys(KEYS).join(', ')}.`);
  return mapped;
}

/** True for a key that only moves or switches (judged on the mapped keycode); unknown names are not. */
export function movingKey(name: string): boolean {
  try { return MOVING_KEYCODES.has(keycode(String(name ?? ''))); } catch { return false; }
}

/** Candidate adb paths from the Android SDK environment and default install folders. */
export function sdkCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
  const exe = platform === 'win32' ? 'adb.exe' : 'adb';
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const roots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT].filter((root): root is string => Boolean(root));
  if (platform === 'win32' && env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, 'Android', 'Sdk'));
  if (platform === 'darwin') roots.push(join(home, 'Library', 'Android', 'sdk'));
  if (platform === 'linux') roots.push(join(home, 'Android', 'Sdk'));
  const out = roots.map((root) => join(root, 'platform-tools', exe));
  if (platform === 'win32' && env.LOCALAPPDATA) {
    // winget (Google.PlatformTools): a link in Links, or – without symlink rights – only the package folder.
    out.push(join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', exe));
    out.push(join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages', 'Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe', 'platform-tools', exe));
  }
  if (platform !== 'win32') out.push('/usr/bin/adb', '/usr/local/bin/adb', '/opt/homebrew/bin/adb');
  return out;
}
