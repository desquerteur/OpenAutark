// Keyboard shortcuts → Windows virtual-key codes for the helper's `key` op.
// Owns: the key-name table and parsing of combos like "ctrl+shift+s", "alt+f4", "enter".
// Never: injects input (the helper does) or accepts unknown names (they are rejected so a
// typo never presses something unexpected).

import { WorkforceError } from '../../shared/errors.ts';

const NAMED: Record<string, number> = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, return: 0x0d, shift: 0x10, ctrl: 0x11, control: 0x11, alt: 0x12,
  pause: 0x13, capslock: 0x14, esc: 0x1b, escape: 0x1b, space: 0x20, pageup: 0x21, pagedown: 0x22, end: 0x23,
  home: 0x24, left: 0x25, up: 0x26, right: 0x27, down: 0x28, printscreen: 0x2c, insert: 0x2d, delete: 0x2e, del: 0x2e,
  win: 0x5b, meta: 0x5b, cmd: 0x5b, menu: 0x5d, apps: 0x5d,
  numpad0: 0x60, numpad1: 0x61, numpad2: 0x62, numpad3: 0x63, numpad4: 0x64, numpad5: 0x65, numpad6: 0x66,
  numpad7: 0x67, numpad8: 0x68, numpad9: 0x69, multiply: 0x6a, add: 0x6b, subtract: 0x6d, decimal: 0x6e, divide: 0x6f,
  numlock: 0x90, scrolllock: 0x91,
  semicolon: 0xba, plus: 0xbb, equal: 0xbb, comma: 0xbc, minus: 0xbd, period: 0xbe, slash: 0xbf, backquote: 0xc0,
  bracketleft: 0xdb, backslash: 0xdc, bracketright: 0xdd, quote: 0xde,
  volumemute: 0xad, volumedown: 0xae, volumeup: 0xaf, medianext: 0xb0, mediaprev: 0xb1, mediastop: 0xb2, mediaplay: 0xb3,
};

const PUNCTUATION: Record<string, number> = {
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
};

const MODIFIERS = new Set([0x10, 0x11, 0x12, 0x5b]);

/** Virtual-key code for one key name ("a", "F5", "enter", "ctrl", ";"). */
export function keyCode(name: string): number | undefined {
  const raw = name.trim();
  if (raw.length === 1) {
    const char = raw.toUpperCase();
    if (/[A-Z0-9]/.test(char)) return char.charCodeAt(0);
    return PUNCTUATION[raw];
  }
  const lower = raw.toLowerCase();
  const fn = /^f([1-9]|1\d|2[0-4])$/.exec(lower);
  if (fn) return 0x6f + Number(fn[1]);
  return NAMED[lower];
}

/**
 * Parses "ctrl+shift+s" into virtual keys: modifiers first (in the given order), the main key
 * last. A combo may consist of modifiers only ("shift"). Max 4 keys.
 */
export function parseCombo(combo: string): number[] {
  const text = combo.trim();
  if (!text) throw new WorkforceError('bad_request', 'Name a key, e.g. "enter" or "ctrl+s".');
  // "+" itself is a key name ("ctrl++" or "plus"); split on "+" that separates names.
  const parts = text === '+' ? ['+'] : text.replace(/\+\+$/, '+plus').split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 4) throw new WorkforceError('bad_request', `Invalid key combination "${combo}".`);
  const codes: number[] = [];
  for (const part of parts) {
    const code = part === '+' ? NAMED.plus : keyCode(part);
    if (code === undefined) throw new WorkforceError('bad_request', `Unknown key "${part}". Use names like enter, tab, esc, ctrl, shift, alt, win, f5, a, 1, left.`);
    if (codes.includes(code)) continue;
    codes.push(code);
  }
  const modifiers = codes.filter((code) => MODIFIERS.has(code));
  const others = codes.filter((code) => !MODIFIERS.has(code));
  if (others.length > 1) throw new WorkforceError('bad_request', `Press one main key at a time ("${combo}" has ${others.length}).`);
  return [...modifiers, ...others];
}

/** Combos the agent must never send: they would reach the secure desktop or log the person out. */
export function forbiddenCombo(codes: number[]): string | undefined {
  const set = new Set(codes);
  if (set.has(0x11) && set.has(0x12) && set.has(0x2e)) return 'Ctrl+Alt+Delete opens the secure screen; I ask the person instead.';
  if (set.has(0x5b) && set.has(0x4c)) return 'Win+L locks the computer; I keep the screen unlocked.';
  return undefined;
}
