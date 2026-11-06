// The person's input on the browser live view while they have taken it over (MP9,
// BrowserFrame.tsx): DOM pointer, wheel and key events → BrowserInput for browser.input. Points
// are on the frame as drawn (the picture keeps its aspect ratio inside its box, object-fit:
// contain), keys carry CDP modifiers (Alt 1, Ctrl 2, Meta 4, Shift 8). Esc is not forwarded (it
// returns the keyboard to the app); Ctrl/Cmd+V arrives as the paste's text instead. The sender
// keeps the order, has one call in flight and merges moves and wheel turns that pile up.
// Owns: these pure helpers. Never: renders, logs input or keeps it after it was sent.

import type { BrowserButton, BrowserInput } from '../../shared/model/browser.ts';

export interface Box { left: number; top: number; width: number; height: number }
export interface FrameSize { width: number; height: number }
export interface FramePoint { x: number; y: number; width: number; height: number }

/** Inputs waiting at most (a stalled link must not pile up memory). */
const MAX_QUEUE = 300;
const MAX_DELTA = 10_000;
/** Text one paste may send (the runtime's limit). */
export const MAX_PASTE = 2000;

/** Where the frame is drawn inside its box (object-fit: contain). */
export function drawnArea(box: Box, frame: FrameSize): Box {
  if (!(frame.width > 0 && frame.height > 0 && box.width > 0 && box.height > 0)) return box;
  const scale = Math.min(box.width / frame.width, box.height / frame.height);
  const width = frame.width * scale;
  const height = frame.height * scale;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

/** A client point in frame units (`frame` width × height, else the drawn size); undefined outside the picture. */
export function framePoint(clientX: number, clientY: number, box: Box, frame: FrameSize): FramePoint | undefined {
  const area = drawnArea(box, frame);
  if (!(area.width > 0 && area.height > 0)) return undefined;
  const fx = (clientX - area.left) / area.width;
  const fy = (clientY - area.top) / area.height;
  if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) return undefined;
  const width = frame.width > 0 ? frame.width : area.width;
  const height = frame.height > 0 ? frame.height : area.height;
  return { x: Math.round(fx * width * 100) / 100, y: Math.round(fy * height * 100) / 100, width, height };
}

interface ModifierKeys { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }

export function modifiersOf(event: ModifierKeys): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

/** MouseEvent.button → the page's button. */
export function buttonOf(button: number): BrowserButton | undefined {
  return button === 0 ? 'left' : button === 1 ? 'middle' : button === 2 ? 'right' : undefined;
}

interface KeyLike extends ModifierKeys { key: string; code: string; keyCode?: number; repeat?: boolean; isComposing?: boolean }

/** A key event to forward, or undefined for the ones the app keeps (see the header). */
export function keyInput(event: KeyLike, type: 'down' | 'up'): BrowserInput | undefined {
  const name = event.key;
  if (!name || name.length > 32 || event.isComposing || /^(Escape|Unidentified|Process|Dead)$/.test(name)) return undefined;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && name.toLowerCase() === 'v') return undefined;
  const input: Extract<BrowserInput, { kind: 'key' }> = { kind: 'key', type, key: name, code: /^[A-Za-z0-9]{0,32}$/.test(event.code) ? event.code : '' };
  const modifiers = modifiersOf(event);
  if (modifiers) input.modifiers = modifiers;
  if (Number.isSafeInteger(event.keyCode) && event.keyCode! > 0 && event.keyCode! <= 255) input.keyCode = event.keyCode;
  if (event.repeat) input.repeat = true;
  return input;
}

/** Pasted text the page may get (no control characters but tabs and line breaks, at most MAX_PASTE). */
export function pasteText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, MAX_PASTE);
}

/** A wheel delta in pixels (deltaMode 1 = lines, 2 = pages). */
export function wheelPixels(delta: number, mode: number): number {
  const pixels = mode === 1 ? delta * 40 : mode === 2 ? delta * 800 : delta;
  return Math.max(-MAX_DELTA, Math.min(MAX_DELTA, Math.round(pixels)));
}

export interface InputSender {
  /** Queues `input` for the tab the person saw (`tab`, the frame's). */
  push(tab: string, input: BrowserInput): void;
  /** Drops what waits (the takeover ended, the view closed). */
  clear(): void;
  pending(): number;
}

interface Queued { tab: string; input: BrowserInput }

const isMove = (input: BrowserInput | undefined): boolean => input?.kind === 'mouse' && input.type === 'move';

/**
 * Sends inputs in order, one call at a time, each for the tab it was made on. A move waiting
 * behind another move on the same tab replaces it, a wheel turn adds to a waiting one. A failed
 * input drops what waits behind it (keys meant for a page that is gone) and is reported once; a
 * failed move is not reported.
 */
export function createInputSender(send: (tab: string, input: BrowserInput) => Promise<unknown>, onError: (error: unknown) => void): InputSender {
  let queue: Queued[] = [];
  let busy = false;
  const pump = async () => {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const next = queue.shift()!;
        try {
          await send(next.tab, next.input);
        } catch (error) {
          queue = [];
          if (!isMove(next.input)) onError(error);
        }
      }
    } finally {
      busy = false;
    }
  };
  return {
    push(tab, input) {
      const last = queue[queue.length - 1];
      const same = last?.tab === tab;
      if (same && isMove(input) && isMove(last.input)) last.input = input;
      else if (same && input.kind === 'wheel' && last.input.kind === 'wheel') {
        const clamp = (value: number) => Math.max(-MAX_DELTA, Math.min(MAX_DELTA, value));
        last.input = { ...input, deltaX: clamp(last.input.deltaX + input.deltaX), deltaY: clamp(last.input.deltaY + input.deltaY) };
      } else if (queue.length >= MAX_QUEUE) {
        if (!isMove(input)) onError(new Error('Too much input at once. Wait a moment.'));
        return;
      } else queue.push({ tab, input });
      void pump();
    },
    clear() { queue = []; },
    pending() { return queue.length; },
  };
}
