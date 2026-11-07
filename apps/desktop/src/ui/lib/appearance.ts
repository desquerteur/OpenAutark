// The window's view on settings.json › appearance (shared/model/appearance.ts): where a chat's tabs dock and how large
// they are (AF-010), read forgivingly from the settings signal and written back whole. A drag shows its live value
// first (`dockLive`) and writes once when it ends. While a dock or a tab is dragged the native website pages step
// aside (`dock-dragging` on <html>; workspace/native-surface.ts hides them), so the pointer never lands in a page.
// Owns: those signals and their writes. Never: geometry rules (the shared model) or the drawing (chat/ChatArea.tsx).

import { computed, signal } from '@preact/signals';
import { DEFAULT_CHAT_DOCK, chatDockOf, type ChatDock, type DockPlace } from '../../shared/model/appearance.ts';
import { settings, updateSettings } from './store.ts';
import { toastError } from './toasts.ts';

/** A value a drag shows before it is saved (null: none). */
export const dockLive = signal<Partial<ChatDock> | null>(null);

/** The saved dock, as settings.json says (defaults for anything missing or unusable). */
export const savedDock = computed<ChatDock>(() => chatDockOf(settings.value?.appearance?.chatDock));

/** The dock as the window draws it now: the saved one with a drag's live value over it. */
export const chatDock = computed<ChatDock>(() => ({ ...savedDock.value, ...(dockLive.value ?? {}) }));

/** Writes the dock (the whole object, so every device reads the same) and ends a live value. */
export function saveDock(patch: Partial<ChatDock>): Promise<void> {
  const next = chatDockOf({ ...savedDock.peek(), ...patch });
  return updateSettings({ appearance: { chatDock: next } }).finally(() => { dockLive.value = null; });
}

/** Moves the chat's tabs to `place` (the menu, a drop, Settings › Appearance). */
export function dockAt(place: DockPlace, more: Partial<ChatDock> = {}): void {
  void saveDock({ ...more, place }).catch((error) => toastError(error, 'Could not move the chat tabs'));
}

/** Back to the shipped place and sizes. */
export function resetDock(): void {
  void saveDock({ ...DEFAULT_CHAT_DOCK }).catch((error) => toastError(error));
}

/** A dock or tab drag started (true) or ended (false): native pages hide meanwhile and come back after. */
export function setDockDragging(on: boolean): void {
  document.documentElement.classList.toggle('dock-dragging', on);
  surfacesMoved();
}

/** Tells every native surface to measure again (a slot moved without resizing: a floating window, a dock change). */
export function surfacesMoved(): void {
  document.dispatchEvent(new Event('wf-surfaces-moved'));
}
