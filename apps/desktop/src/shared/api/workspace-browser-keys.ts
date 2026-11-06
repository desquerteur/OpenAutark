// Browser shortcuts, Chrome's keys – one mapping for both places a key is pressed: inside a page (main reads it in
// before-input-event, key down only, and the page never gets it – main/workspace-chrome.ts) and with the keyboard in the
// pane (ui/workspace/pane-shortcuts.ts). Three kinds: 'main' – what the tab itself does (reload, back/forward, zoom,
// DevTools, stop, reopen a closed tab); 'app' – what the app's browser does (a new tab, closing or choosing a tab, the
// address field, find, history); 'host' – the app's own shortcuts (sidebar, palette, settings, new chat) that a page
// passes on. mod is Cmd on macOS and Ctrl elsewhere; Ctrl+Tab is Ctrl everywhere, as in Chrome. Escape only stops a page
// that is loading – otherwise it is the page's.
// Owns: that mapping. Never: acts on a key itself.

import type { BrowserKeyAction } from './workspace-browser.ts';

export type MainKeyAction = 'reload' | 'hard-reload' | 'back' | 'forward' | 'zoom-in' | 'zoom-out' | 'zoom-reset' | 'devtools' | 'stop' | 'reopen';
export type PageKey = { main: MainKeyAction } | { app: Exclude<BrowserKeyAction, 'send-page'> } | { host: string };

/** The parts of a key press this needs (Electron's Input; a DOM KeyboardEvent maps to it). */
export interface KeyInput { type: string; key: string; control: boolean; meta: boolean; shift: boolean; alt: boolean }

/** The app's own shortcuts that reach the app from inside a page (lib/hotkeys.ts: sidebar, palette, settings, new chat). */
const HOST_KEYS = new Set(['b', 'k', ',', 'n']);

export function pageKey(input: KeyInput, mac: boolean, loading: boolean): PageKey | undefined {
  if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return undefined;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  const mod = mac ? input.meta : input.control;
  const only = mod && !input.alt;
  if (key === 'F12' || (mod && input.shift && (key === 'i' || key === 'j')) || (mac && input.meta && input.alt && key === 'i')) return { main: 'devtools' };
  if (key === 'F5') return { main: input.shift || input.control ? 'hard-reload' : 'reload' };
  if (key === 'F6' || (input.alt && !mod && key === 'd' && !mac)) return { app: 'address' };
  if (key === 'Escape' && !mod && !input.alt && !input.shift) return loading ? { main: 'stop' } : undefined;
  if (input.alt && !mod && !input.shift && !mac) {
    if (key === 'ArrowLeft') return { main: 'back' };
    if (key === 'ArrowRight') return { main: 'forward' };
  }
  if (input.control && !input.alt && (key === 'Tab' || key === 'PageDown' || key === 'PageUp')) {
    return { app: key === 'PageUp' || (key === 'Tab' && input.shift) ? 'previous-tab' : 'next-tab' };
  }
  if (!only) return undefined;
  if (mac && (key === '[' || key === ']') && !input.shift) return { main: key === '[' ? 'back' : 'forward' };
  if (input.shift) {
    if (key === 'r') return { main: 'hard-reload' };
    if (key === '+' || key === '=') return { main: 'zoom-in' };
    if (key === 't') return { main: 'reopen' };
    return undefined;
  }
  if (/^[1-9]$/.test(key)) return { app: `tab-${Number(key) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}` };
  if (key === (mac ? 'y' : 'h')) return { app: 'history' };
  if (key === 't') return { app: 'new-tab' };
  if (key === 'w') return { app: 'close-tab' };
  if (key === 'l') return { app: 'address' };
  if (key === 'f') return { app: 'find' };
  if (key === 'r') return { main: 'reload' };
  if (key === '=' || key === '+') return { main: 'zoom-in' };
  if (key === '-') return { main: 'zoom-out' };
  if (key === '0') return { main: 'zoom-reset' };
  if (HOST_KEYS.has(key)) return { host: key };
  return undefined;
}
