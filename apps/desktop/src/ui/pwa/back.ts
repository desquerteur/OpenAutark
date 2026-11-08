// B-078: one Back on the phone, layer by layer – an open dialog (search, new chat, feedback, plans, a context menu, a
// confirm), the global sheet, the chat's side panel (details or a thread, a bottom sheet on the phone), the chat's
// area, a pushed screen (a chat → Chats, an agent or a person → Team, a task → Work), a settings section →
// all settings → Home, any other tab → My day; on My day it is done (false). The Android app's Back calls
// window.autarkBack() (evaluateJavascript) and puts itself in the background on false – it never closes. In a browser
// PWA the sheet, the chat's panel (phone layout) and the chat's area get a history entry of their own while open, so
// the system Back closes them first;
// pushed screens are history entries already (lib/router.ts navigate).
// Owns: that order and the PWA's layer entries. Never: what a screen shows, or closes the app.

import { effect } from '@preact/signals';
import type { Route } from '../lib/router.ts';
import { navigate } from '../lib/router.ts';
import { backLayerOpen, closeBackLayer } from '../lib/back-layers.ts';
import { chatPanel, feedbackOpen, isChatAreaOpen, newChatOpen, paletteOpen, setChatArea, setChatPanel, usageOpen } from '../lib/shell-state.ts';
import { isMobile, route } from '../lib/store.ts';
import { phonePaneOpen } from '../workspace/phone-pane.ts';
import { isAndroidApp } from './native.ts';

declare global {
  interface Window {
    /** One layer back; false when there is none left (My day). */
    autarkBack?: () => boolean;
  }
}

export interface Layers { overlay: boolean; sheet: boolean; area: boolean; panel?: boolean }

/** What one Back does from here (pure): close a layer, go to a route, or nothing left (false). */
export function nextBack(current: Route, open: Layers): 'overlay' | 'sheet' | 'panel' | 'area' | Route | false {
  if (open.overlay) return 'overlay';
  if (open.sheet) return 'sheet';
  switch (current.view) {
    case 'chat': return open.panel ? 'panel' : open.area ? 'area' : { view: 'chats' };
    case 'team': return current.agentId || current.personId || current.splitId ? { view: 'team' } : { view: 'home' };
    case 'tasks': return current.task ? { view: 'tasks' } : { view: 'home' };
    case 'settings': return current.section ? { view: 'settings' } : { view: 'home' };
    case 'chats': return { view: 'home' };
    case 'projects': return current.id ? { view: 'projects' } : { view: 'home' }; // AF-018: a project's page → the list
    default: return false; // 'home' and 'day': My day
  }
}

/** The chat's side panel as a layer: only in the phone layout, where it is a bottom sheet over the chat. */
const panelOpen = (current: Route, panel = chatPanel.peek()) => current.view === 'chat' && isMobile.peek() && panel !== null;

function layers(current: Route): Layers {
  return {
    overlay: paletteOpen.peek() || newChatOpen.peek() !== null || feedbackOpen.peek() !== null || usageOpen.peek() || backLayerOpen(),
    sheet: phonePaneOpen.peek(),
    panel: panelOpen(current),
    area: current.view === 'chat' && isChatAreaOpen(current.id),
  };
}

/** One layer back (window.autarkBack). */
export function autarkBack(): boolean {
  const current = route.peek();
  const step = nextBack(current, layers(current));
  if (step === false) return false;
  if (step === 'overlay') {
    if (backLayerOpen()) { closeBackLayer(); return true; } // a menu or a confirm is the topmost
    paletteOpen.value = false; newChatOpen.value = null; feedbackOpen.value = null; usageOpen.value = false; return true;
  }
  if (step === 'sheet') { phonePaneOpen.value = false; return true; }
  if (step === 'panel') { if (current.view === 'chat') setChatPanel(current.id, null); return true; }
  if (step === 'area') { if (current.view === 'chat') setChatArea(current.id, false); return true; }
  navigate(step);
  return true;
}

const LAYER = 'autark-layer';

/** Starts Back for this page: window.autarkBack, and in a browser PWA the layer entries for the sheet and the chat's area. */
export function startBack(): () => void {
  window.autarkBack = autarkBack;
  if (isAndroidApp()) return () => { delete window.autarkBack; };
  let held = false;
  const offEffect = effect(() => {
    const current = route.value;
    const open = phonePaneOpen.value || (current.view === 'chat' && ((isMobile.value && chatPanel.value !== null) || isChatAreaOpen(current.id)));
    if (open && !held) { history.pushState({ [LAYER]: true }, '', location.hash); held = true; }
    else if (!open && held) {
      held = false;
      if ((history.state as Record<string, unknown> | null)?.[LAYER]) history.back(); // closed by a click: its entry goes too
    }
  });
  const popped = () => {
    if (!held) return;
    held = false; // the browser took the layer's entry
    const current = route.peek();
    if (phonePaneOpen.peek()) phonePaneOpen.value = false;
    else if (current.view === 'chat' && panelOpen(current)) setChatPanel(current.id, null);
    else if (current.view === 'chat' && isChatAreaOpen(current.id)) setChatArea(current.id, false);
  };
  window.addEventListener('popstate', popped);
  return () => { offEffect(); window.removeEventListener('popstate', popped); delete window.autarkBack; };
}
