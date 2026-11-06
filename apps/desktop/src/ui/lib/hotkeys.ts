// Global keyboard shortcuts. Combos are written like "mod+k", "mod+shift+o", "mod+,".
// `mod` is Cmd on macOS and Ctrl elsewhere.
// Owns: one keydown listener and the shortcut registry. Never: handles keys inside inputs
// unless the combo uses mod (plain letters always belong to the focused field).

import { os } from './platform.ts';

type Handler = (event: KeyboardEvent) => void;
const registry = new Map<string, Handler>();
let installed = false;

function comboOf(event: KeyboardEvent): string {
  const parts: string[] = [];
  const mod = os === 'mac' ? event.metaKey : event.ctrlKey;
  if (mod) parts.push('mod');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push(event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase());
  return parts.join('+');
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing) return;
  const combo = comboOf(event);
  const handler = registry.get(combo);
  if (!handler) return;
  const target = event.target as HTMLElement | null;
  const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  if (typing && !combo.startsWith('mod')) return;
  event.preventDefault();
  handler(event);
}

/** Registers a shortcut; returns an unregister function. */
export function hotkey(combo: string, handler: Handler): () => void {
  if (!installed) {
    installed = true;
    window.addEventListener('keydown', onKeyDown);
  }
  registry.set(combo, handler);
  return () => { if (registry.get(combo) === handler) registry.delete(combo); };
}

/** Human-readable label, e.g. "Ctrl+K" / "⌘K". */
export function comboLabel(combo: string): string {
  return combo.split('+').map((part) => {
    if (part === 'mod') return os === 'mac' ? '⌘' : 'Ctrl';
    if (part === 'shift') return os === 'mac' ? '⇧' : 'Shift';
    if (part === 'alt') return os === 'mac' ? '⌥' : 'Alt';
    return part.length === 1 ? part.toUpperCase() : part;
  }).join(os === 'mac' ? '' : '+');
}
