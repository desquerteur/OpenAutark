// The person's input on the browser live view (view.ts): a point on the frame as the person
// saw it → CSS pixels of the page's viewport (from the screencast frame's metadata: deviceWidth
// and deviceHeight in DIP, offsetTop, pageScaleFactor), and one input → the Chrome DevTools
// Protocol commands that do it in the agent's tab (Input.dispatchMouseEvent, dispatchKeyEvent,
// insertText). Modifiers are CDP's bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8.
// Owns: the mapping, the key table and the commands. Never: logs or keeps what is typed, or sends anything
// outside the given CDP session.

import { WorkforceError } from '../../shared/errors.ts';
import type { BrowserInput } from '../../shared/model/browser.ts';
import type { CdpSessionLike } from './page.ts';

/** The page viewport a frame shows: DIP size, top offset (DIP) and page scale (pinch zoom). */
export interface FrameMeta { width: number; height: number; offsetTop: number; scale: number }

export interface CdpCommand { method: string; params: Record<string, unknown> }

const ALT = 1;
const CTRL = 2;
const META = 4;

/** Named keys without a printable character → Windows virtual key code (CDP needs it for default actions). */
const KEY_CODES: Readonly<Record<string, number>> = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Pause: 19, CapsLock: 20, Escape: 27, ' ': 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
  Meta: 91, ContextMenu: 93,
};

const BUTTON_MASK = { left: 1, right: 2, middle: 4 } as const;

const finite = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);
const round = (value: number): number => Math.round(value * 100) / 100;

/** The viewport of a screencast frame's metadata; undefined when it does not say. */
export function frameMeta(metadata: unknown): FrameMeta | undefined {
  const m = metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {};
  const width = finite(m.deviceWidth, 0);
  const height = finite(m.deviceHeight, 0);
  if (width <= 0 || height <= 0) return undefined;
  const scale = finite(m.pageScaleFactor, 1);
  return { width, height, offsetTop: clamp(finite(m.offsetTop, 0), 0, height), scale: scale > 0 ? scale : 1 };
}

/** A point on the frame as the person saw it (`width` × `height`, any unit) in the page's CSS pixels. */
export function toCss(point: { x: number; y: number; width: number; height: number }, meta: FrameMeta): { x: number; y: number } {
  const fx = clamp(point.x / point.width, 0, 1);
  const fy = clamp(point.y / point.height, 0, 1);
  const x = (fx * meta.width) / meta.scale;
  const y = (fy * meta.height - meta.offsetTop) / meta.scale;
  return { x: round(clamp(x, 0, meta.width / meta.scale)), y: round(clamp(y, 0, (meta.height - meta.offsetTop) / meta.scale)) };
}

/** The character a key-down types (a printable key without a Ctrl or Meta shortcut; AltGr = Ctrl+Alt types). */
export function keyText(input: Extract<BrowserInput, { kind: 'key' }>): string | undefined {
  if (input.type !== 'down' || [...input.key].length !== 1) return undefined;
  const modifiers = input.modifiers ?? 0;
  if (modifiers & META) return undefined;
  if ((modifiers & CTRL) && !(modifiers & ALT)) return undefined;
  return input.key;
}

/** True for a Ctrl or Meta shortcut (Ctrl+A, Ctrl+Backspace …), not AltGr. */
export function isShortcut(input: Extract<BrowserInput, { kind: 'key' }>): boolean {
  const modifiers = input.modifiers ?? 0;
  return Boolean(modifiers & META) || (Boolean(modifiers & CTRL) && !(modifiers & ALT));
}

function keyCodeOf(input: Extract<BrowserInput, { kind: 'key' }>): number {
  if (input.keyCode) return input.keyCode;
  if (KEY_CODES[input.key] !== undefined) return KEY_CODES[input.key];
  const fn = /^F([1-9]|1\d|2[0-4])$/.exec(input.key);
  if (fn) return 111 + Number(fn[1]);
  if (/^[a-z]$/i.test(input.key)) return input.key.toUpperCase().charCodeAt(0);
  if (/^\d$/.test(input.key)) return input.key.charCodeAt(0);
  return 0;
}

function pointerOf(input: Extract<BrowserInput, { kind: 'mouse' | 'wheel' }>, meta: FrameMeta | undefined): { x: number; y: number } {
  if (!meta) throw new WorkforceError('conflict', 'There is no picture of this tab yet. Wait a moment, then click again.');
  return toCss(input, meta);
}

/** The CDP commands for one input (in order). */
export function inputCommands(input: BrowserInput, meta: FrameMeta | undefined): CdpCommand[] {
  switch (input.kind) {
    case 'text':
      return [{ method: 'Input.insertText', params: { text: input.text } }];
    case 'key': {
      const keyCode = keyCodeOf(input);
      const modifiers = input.modifiers ?? 0;
      const base = { key: input.key, code: input.code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
      if (input.type === 'up') return [{ method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...base, modifiers } }];
      const text = keyText(input) ?? (input.key === 'Enter' && !isShortcut(input) ? '\r' : undefined);
      // An AltGr character (Ctrl+Alt on Windows) is typed, not a Ctrl+Alt shortcut.
      const sent = text && (modifiers & CTRL) && (modifiers & ALT) ? modifiers & ~(CTRL | ALT) : modifiers;
      return [{
        method: 'Input.dispatchKeyEvent',
        params: { type: text ? 'keyDown' : 'rawKeyDown', ...base, modifiers: sent, ...(text ? { text, unmodifiedText: text } : {}), ...(input.repeat ? { autoRepeat: true } : {}) },
      }];
    }
    case 'wheel': {
      const at = pointerOf(input, meta);
      return [{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', ...at, deltaX: input.deltaX, deltaY: input.deltaY, modifiers: input.modifiers ?? 0 } }];
    }
    case 'mouse': {
      const at = pointerOf(input, meta);
      if (input.type === 'move') {
        const buttons = input.buttons ?? 0;
        const button = buttons & 1 ? 'left' : buttons & 2 ? 'right' : buttons & 4 ? 'middle' : 'none';
        return [{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', ...at, button, buttons, modifiers: input.modifiers ?? 0 } }];
      }
      const button = input.button ?? 'left';
      const buttons = input.buttons ?? (input.type === 'down' ? BUTTON_MASK[button] : 0);
      return [{
        method: 'Input.dispatchMouseEvent',
        params: { type: input.type === 'down' ? 'mousePressed' : 'mouseReleased', ...at, button, buttons, clickCount: input.clicks ?? 1, modifiers: input.modifiers ?? 0 },
      }];
    }
    default:
      throw new WorkforceError('bad_request', 'Unknown input.');
  }
}

/** Sends one input to the tab. Failures get a fixed text (a CDP error never carries the input into a log or toast). */
export async function sendInput(cdp: CdpSessionLike, input: BrowserInput, meta: FrameMeta | undefined): Promise<void> {
  const commands = inputCommands(input, meta);
  try {
    for (const command of commands) await cdp.send(command.method, command.params);
  } catch {
    throw new WorkforceError('unavailable', 'The browser did not take that input. Try again.');
  }
}
