// Touch on the taken-over browser picture (X02, BrowserSurface.tsx) and the hidden key field for
// the phone's on-screen keyboard (BrowserKeys.tsx), as pure helpers over BrowserInput:
//   * a tap (≤ TAP_MS, ≤ TAP_SLOP_PX of movement – jitter stays a tap) is a left click at the
//     frame point where it started; a second tap within DOUBLE_TAP_MS and DOUBLE_TAP_PX is a
//     double click (clicks 2);
//   * one finger dragging at 1x scrolls the page: wheel turns at the start point, the finger's
//     movement in frame pixels (screen delta × frame width / drawn width, opposite sign – the page
//     follows the finger); at 2x the zoom box pans natively and sends nothing (taps still click);
//   * two or more fingers are ignored until all are lifted.
// The key proxy reads a field that always holds one zero-width SENTINEL: typed or inserted text
// becomes {kind: 'text'}, deleting the sentinel is Backspace, Enter is Enter (down and up), and
// Tab and arrow keys from a hardware keyboard pass as keys; the field goes back to the sentinel
// after every event, so nothing typed stays in it.
// Owns: these rules. Never: renders, logs or keeps input.

import type { BrowserInput } from '../../shared/model/browser.ts';
import { keyInput, pasteText, type FramePoint } from './browser-input.ts';

export const TAP_MS = 250;
export const TAP_SLOP_PX = 8;
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 24;
/** What the hidden key field holds between events (zero width, never sent). */
export const KEY_SENTINEL = '​';
const MAX_DELTA = 10_000;

export interface TouchMap {
  /** A client point on the picture in frame units (undefined outside it). */
  point(clientX: number, clientY: number): FramePoint | undefined;
  /** Frame pixels per screen pixel (frame width / drawn width). */
  scale(): number;
  /** 2: the picture is zoomed and one finger pans its box natively. */
  zoom(): 1 | 2;
}

interface TouchPoint { clientX: number; clientY: number }
/** The parts of a TouchEvent the gestures read. */
export interface TouchLike { touches: ArrayLike<TouchPoint>; timeStamp: number }

export interface TouchGestures {
  start(event: TouchLike): void;
  move(event: TouchLike): void;
  /** true: handled here (a tap or a scroll) – the caller cancels the synthetic mouse events. */
  end(event: TouchLike): boolean;
  cancel(): void;
}

interface Gesture { x: number; y: number; at: number; lastX: number; lastY: number; dragging: boolean; multi: boolean }

const clamp = (value: number) => Math.max(-MAX_DELTA, Math.min(MAX_DELTA, Math.round(value)));

export function touchGestures(map: TouchMap, push: (input: BrowserInput) => void): TouchGestures {
  let gesture: Gesture | undefined;
  let lastTap: { x: number; y: number; at: number } | undefined;
  return {
    start(event) {
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) {
        if (gesture) gesture.multi = true;
        else gesture = { x: 0, y: 0, at: event.timeStamp, lastX: 0, lastY: 0, dragging: false, multi: true };
        return;
      }
      gesture = { x: touch.clientX, y: touch.clientY, at: event.timeStamp, lastX: touch.clientX, lastY: touch.clientY, dragging: false, multi: false };
    },
    move(event) {
      if (!gesture || gesture.multi) return;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) { gesture.multi = true; return; }
      if (!gesture.dragging && Math.hypot(touch.clientX - gesture.x, touch.clientY - gesture.y) <= TAP_SLOP_PX) return;
      gesture.dragging = true;
      if (map.zoom() === 2) return; // the zoom box pans natively
      const dx = touch.clientX - gesture.lastX;
      const dy = touch.clientY - gesture.lastY;
      gesture.lastX = touch.clientX;
      gesture.lastY = touch.clientY;
      const at = map.point(gesture.x, gesture.y);
      if (!at || (!dx && !dy)) return;
      const scale = map.scale();
      push({ kind: 'wheel', ...at, deltaX: clamp(-dx * scale), deltaY: clamp(-dy * scale) });
    },
    end(event) {
      const done = gesture;
      if (event.touches.length === 0) gesture = undefined;
      if (!done || done.multi) return false;
      if (done.dragging) return map.zoom() === 1;
      if (event.timeStamp - done.at > TAP_MS) return true; // a long press does nothing
      const at = map.point(done.x, done.y);
      if (!at) return true;
      const double = lastTap !== undefined && done.at - lastTap.at <= DOUBLE_TAP_MS && Math.hypot(done.x - lastTap.x, done.y - lastTap.y) <= DOUBLE_TAP_PX;
      const clicks = double ? 2 : 1;
      lastTap = double ? undefined : { x: done.x, y: done.y, at: event.timeStamp };
      push({ kind: 'mouse', type: 'down', ...at, button: 'left', buttons: 1, clicks });
      push({ kind: 'mouse', type: 'up', ...at, button: 'left', buttons: 0, clicks });
      return true;
    },
    cancel() { gesture = undefined; },
  };
}

// ------------------------------------------------------------------ the hidden key field

type KeyEventLike = Parameters<typeof keyInput>[0];

export interface KeyProxy {
  /** The field's value after an input event → what to put back in the field (the sentinel). */
  input(value: string): string;
  /** A key event: true when it was sent here (the caller prevents its default). */
  key(event: KeyEventLike, type: 'down' | 'up'): boolean;
}

/** Keys of a hardware keyboard the field passes on (letters arrive as text through input()). */
const PASSED_KEYS = /^(Tab|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Delete)$/;

export function keyProxy(push: (input: BrowserInput) => void): KeyProxy {
  const press = (key: string, keyCode: number) => {
    push({ kind: 'key', type: 'down', key, code: key, keyCode });
    push({ kind: 'key', type: 'up', key, code: key, keyCode });
  };
  return {
    input(value) {
      const text = pasteText(value.split(KEY_SENTINEL).join(''));
      if (text) push({ kind: 'text', text });
      else if (!value.includes(KEY_SENTINEL)) press('Backspace', 8);
      return KEY_SENTINEL;
    },
    key(event, type) {
      if (event.key === 'Enter') {
        if (type === 'down' && !event.isComposing) press('Enter', 13);
        return true;
      }
      if (!PASSED_KEYS.test(event.key)) return false;
      const input = keyInput(event, type);
      if (input) push(input);
      return Boolean(input);
    },
  };
}
