// Applies appearance preferences to <html>: data-theme (system|light|dark; reduced motion follows the
// OS media query in the CSS, the person's look is <data>/theme.css – main.tsx) and the platform/os classes the CSS uses for window-bar
// spacing. B-044 visual pass (desktop): data-focus-quiet from the start and whenever the window loses
// focus until a key is pressed in it – a window that gains focus (at start, or when the person comes
// back to it) may have its first control focused by the native focus traversal (the window holds
// several web views: the person's website tabs), which Chromium marks :focus-visible as if Tab had
// been pressed; base.css hides that ring while quiet. Tab (any key) brings the keyboard ring back.
// Owns: document-level attributes. Never: defines colors (styles/tokens.css does).

import { effect } from '@preact/signals';
import { os, platform } from './platform.ts';
import { preferences } from './store.ts';

export function applyTheme(): void {
  const root = document.documentElement;
  root.dataset.platform = platform;
  root.dataset.os = os;
  if (platform === 'desktop') {
    root.dataset.focusQuiet = '';
    window.addEventListener('blur', () => { root.dataset.focusQuiet = ''; });
    window.addEventListener('keydown', () => { delete root.dataset.focusQuiet; }, true);
  }
  effect(() => {
    const prefs = preferences.value;
    root.dataset.theme = prefs.theme;
    const meta = document.querySelector<HTMLMetaElement>('meta[name=color-scheme]');
    if (meta) meta.content = prefs.theme === 'system' ? 'light dark' : prefs.theme;
  });
}
