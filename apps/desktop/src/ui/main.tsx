// UI composition root (desktop window and PWA – one bundle).
// Order matters: on desktop the runtime connector is claimed before anything else, then appearance (no flash),
// routing/layout and the first render (boot state), then – in the browser build – pairing (it must finish before
// the first WebSocket Hello), then event wiring, the repair watch,
// the person's theme.css, desktop bridge glue and finally the RPC connection.
// Owns: startup order and the few global effects (theme-color, the theme.css style). Never: view logic, data
// shaping or anything a component could own.

import './styles/index.css';
import { render } from 'preact';
import { effect } from '@preact/signals';
import { applyTheme } from './lib/theme.ts';
import { startRouter } from './lib/router.ts';
import { bridge, platform, watchLayout } from './lib/platform.ts';
import { rpc } from './lib/rpc.ts';
import { claimConnector } from './lib/runtime-port.ts';
import { wireEvents } from './lib/store-events.ts';
import { startRepairWatch } from './repair/repair-state.ts';
import { rememberLastChat } from './shell/navigation.ts';
import { theme, watchTheme } from './blocks/host.ts';
import { readTodoSnapshot, startPwa } from './pwa/install.ts';
import { startDesktopBridge } from './boot/desktop.ts';
import { App, offlineSnapshot } from './App.tsx';

/** Keeps the browser/OS chrome color (PWA title bar, Android task switcher) on the theme. */
function syncThemeColor(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name=theme-color]');
  if (!meta) return;
  effect(() => {
    void theme.value;
    const chrome = getComputedStyle(document.documentElement).getPropertyValue('--chrome').trim();
    if (chrome) meta.content = chrome;
  });
}

/** <data>/theme.css (runtime/root/theme.ts) as the last stylesheet: read on every (re)connect, replaced on each change. */
function applyThemeCss(): void {
  const style = document.createElement('style');
  style.id = 'wf-theme-css';
  document.head.append(style);
  const set = (css: string) => { if (style.textContent !== css) style.textContent = css; };
  rpc.on('theme.updated', (file) => set(file.css));
  rpc.onOpen(() => { void rpc.call('theme.get').then((file) => set(file.css)).catch(() => undefined); });
}

async function boot(): Promise<void> {
  if (platform === 'desktop') {
    // Fails closed: if someone claimed it first, the public connect() rejects for us too.
    try { claimConnector(bridge); } catch (error) { console.error('[ui] runtime connector already claimed', error); }
  }
  applyTheme(); // data-theme / platform attributes on <html>
  watchTheme();
  syncThemeColor();
  startRouter();
  watchLayout();
  // The first paint shows the boot state; nothing in it calls the runtime before rpc.start().
  const root = document.getElementById('app');
  if (root) render(<App />, root);
  if (platform === 'pwa') {
    void readTodoSnapshot().then((snapshot) => { if (snapshot) offlineSnapshot.value = snapshot; });
    await startPwa(); // #pair=<secret> → device token, service worker, push, offline mirror
  }
  wireEvents(); // event deltas → store signals; loadAll() on every (re)connect
  startRepairWatch(); // desktop: repair.state on every connect – the repair screen while the runtime runs in repair mode
  applyThemeCss();
  rememberLastChat();
  startDesktopBridge(); // updates, notification clicks, pre-restart flush, restart readiness
  rpc.start();
}

boot().catch((error: unknown) => console.error('[ui] boot failed', error));
