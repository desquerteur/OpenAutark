// Which website each space shows, so the global pane and a chat's area each show a page at the same time. Per space a
// slot: the tab shown there last, the slot's box (whole pixels inside the window, below its 48 px title row) and whether
// that tab is on it now. A show takes the place of the space's tab shown before; a hide takes one tab off its slot (the
// other surface keeps its own); a window resize or reload takes them all off. arrange() puts every view where the slots
// say. The memory saver keeps the tabs on a slot and the last tab of the two spaces shown last (a menu or toast over a
// page takes it off its slot for a moment), and no more: a chat looked at long ago gives its page up like any hidden tab.
// A tab on its slot paints only while its window is on screen (`painted`; a minimized window keeps its slots on).
// Owns: the slots and that placement loop. Never: imports electron, makes, loads or closes a page.

import type { BrowserBounds } from '../shared/api/workspace-browser.ts';

/** A tab's native view as the slots move it (main's WebContentsView), and the error its page shows instead. */
export interface SlotTab { view: { setBounds(box: BrowserBounds): void; setVisible(visible: boolean): void }; error?: string }
interface Slot { id: string; bounds: BrowserBounds; on: boolean }

/** The spaces shown last whose last tab stays loaded off its slot: the global pane and the open chat's area. */
const KEPT_SPACES = 2;
/** The size of a page before any slot was shown. */
const UNSIZED: BrowserBounds = { x: 0, y: 48, width: 1280, height: 800 };

/** The box inside a window content of `width` × `height`: whole pixels, below the title row, at least 1 px. */
export function fit(bounds: BrowserBounds, width: number, height: number): BrowserBounds {
  const x = Math.max(0, Math.min(width - 1, Math.round(bounds.x)));
  const y = Math.max(48, Math.min(height - 1, Math.round(bounds.y)));
  return { x, y, width: Math.max(1, Math.min(Math.round(bounds.width), width - x)), height: Math.max(1, Math.min(Math.round(bounds.height), height - y)) };
}

export class ShownTabs {
  /** In the order the spaces showed (the latest last). */
  private readonly slots = new Map<string, Slot>();
  private latest = UNSIZED;

  /** `id` is `space`'s shown tab now, on `bounds`; a tab that moved to another space leaves its old slot. */
  show(space: string, id: string, bounds: BrowserBounds): void {
    for (const [key, slot] of this.slots) if (slot.id === id || key === space) this.slots.delete(key);
    this.slots.set(space, { id, bounds, on: true });
    this.latest = bounds;
  }

  /** `id` leaves its slot, or every tab without an id; the tabs that were on one. */
  hide(id?: string): string[] {
    const off = [...this.slots.values()].filter((slot) => slot.on && (id === undefined || slot.id === id));
    for (const slot of off) slot.on = false;
    return off.map((slot) => slot.id);
  }

  isShown(id: string): boolean { return [...this.slots.values()].some((slot) => slot.on && slot.id === id); }

  /** On its slot in a window that paints: a minimized or hidden window draws nothing (its slots stay on until it is back). */
  painted(id: string, window: { isVisible(): boolean; isMinimized(): boolean } | null): boolean {
    return this.isShown(id) && Boolean(window?.isVisible() && !window.isMinimized());
  }

  /** The tab `space` shows now. */
  shownIn(space: string): string | null {
    const slot = this.slots.get(space);
    return slot?.on ? slot.id : null;
  }

  /** The box of `space`'s slot, else the one shown last anywhere (a new page gets that size). */
  boundsFor(space: string): BrowserBounds { return this.slots.get(space)?.bounds ?? this.latest; }

  /** On a slot, or the last tab of one of the spaces shown last (see the header). */
  kept(id: string): boolean {
    const slots = [...this.slots.values()];
    return slots.some((slot, index) => slot.id === id && (slot.on || index >= slots.length - KEPT_SPACES));
  }

  /** The window went: no slot is left (the box shown last stays as the size of new pages). */
  clear(): void { this.slots.clear(); }

  /** Each view as the slots say: a shown tab on its box and visible unless its page failed, every other one hidden. `seen` hears each. */
  arrange(tabs: Iterable<[string, SlotTab]>, seen: (id: string, shown: boolean) => void): void {
    const boxes = new Map([...this.slots.values()].filter((slot) => slot.on).map((slot) => [slot.id, slot.bounds] as const));
    for (const [id, tab] of tabs) {
      const box = boxes.get(id);
      if (box) tab.view.setBounds(box);
      tab.view.setVisible(Boolean(box) && !tab.error);
      seen(id, Boolean(box));
    }
  }
}
