// Pure parts of the custom Select (select.tsx): keyboard handling of a select-only combobox
// (WAI-ARIA APG pattern: focus stays on the button, the active option is
// aria-activedescendant), type-ahead and where the popover list goes (below, or above when
// there is no room below).
// Owns: these rules. Never: touches the DOM, renders, or knows option values.

export interface ListState {
  open: boolean;
  /** Visually focused option while open; -1 = none. */
  active: number;
}

export interface ListKeyResult {
  state: ListState;
  /** Choose `state.active` as the new value (the list is already closed in `state`). */
  commit: boolean;
  /** The key was ours: the caller prevents the default action. */
  handled: boolean;
}

export interface KeyInput {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

const PAGE = 10;

function clamp(value: number, count: number): number {
  return Math.max(0, Math.min(count - 1, value));
}

/**
 * One key press on the combobox button. `selected` is the index of the current value (-1 when the
 * value is not among the options). Enter and Space are left to the button's click.
 */
export function listKey(state: ListState, input: KeyInput, count: number, selected: number): ListKeyResult {
  const unhandled = { state, commit: false, handled: false };
  if (count === 0) return unhandled;
  const start = selected >= 0 ? selected : 0;
  const open = (active: number): ListKeyResult => ({ state: { open: true, active: clamp(active, count) }, commit: false, handled: true });
  if (!state.open) {
    switch (input.key) {
      case 'ArrowDown': case 'ArrowUp': return open(start);
      case 'Home': return open(0);
      case 'End': return open(count - 1);
      default: return unhandled;
    }
  }
  const active = state.active >= 0 ? state.active : start;
  switch (input.key) {
    case 'ArrowDown': return open(active + 1);
    case 'ArrowUp':
      if (input.altKey) return { state: { open: false, active }, commit: true, handled: true };
      return open(active - 1);
    case 'Home': return open(0);
    case 'End': return open(count - 1);
    case 'PageDown': return open(active + PAGE);
    case 'PageUp': return open(active - PAGE);
    case 'Escape': return { state: { open: false, active: -1 }, commit: false, handled: true };
    // Tab keeps its default (focus moves on) but takes the active option, like a native select.
    case 'Tab': return { state: { open: false, active }, commit: true, handled: false };
    default: return unhandled;
  }
}

/** Lower case without accents, so "u" finds "Über". */
export function foldLabel(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}

/** A printable single character typed without modifiers (type-ahead input). */
export function isTypeAheadKey(input: KeyInput): boolean {
  return input.key.length === 1 && input.key !== ' ' && !input.ctrlKey && !input.metaKey && !input.altKey;
}

/** Characters typed within this many ms form one search string. */
export const TYPE_AHEAD_MS = 600;

/**
 * Index of the option a type-ahead search lands on, or -1. Repeating one character cycles
 * through the options starting with it; a longer string matches from the active option on.
 */
export function typeAhead(labels: readonly string[], query: string, active: number): number {
  const folded = foldLabel(query);
  if (!folded || labels.length === 0) return -1;
  const chars = Array.from(folded);
  const repeated = chars.every((char) => char === chars[0]);
  const needle = repeated ? chars[0] : folded;
  const from = repeated ? active + 1 : Math.max(0, active);
  for (let offset = 0; offset < labels.length; offset++) {
    const index = (((from + offset) % labels.length) + labels.length) % labels.length;
    if (foldLabel(labels[index]).startsWith(needle)) return index;
  }
  return -1;
}

/** Collects type-ahead characters; a pause longer than TYPE_AHEAD_MS starts a new search. */
export class TypeAheadBuffer {
  private text = '';
  private at = -Infinity;

  push(char: string, now: number): string {
    this.text = now - this.at > TYPE_AHEAD_MS ? char : this.text + char;
    this.at = now;
    return this.text;
  }
}

export interface Box {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

export interface ListPlacement {
  left: number;
  top: number;
  maxHeight: number;
  above: boolean;
}

/**
 * Where the list goes: under the button when its natural height fits there (or there is more
 * room below than above), otherwise above it; height capped by the room and `cap`, left edge
 * clamped into the viewport.
 */
export function placeList(anchor: Box, list: { width: number; height: number }, viewport: { width: number; height: number }, cap = 320, gap = 4, margin = 8): ListPlacement {
  const below = Math.max(0, viewport.height - anchor.bottom - gap - margin);
  const aboveRoom = Math.max(0, anchor.top - gap - margin);
  const wanted = Math.min(list.height, cap);
  const above = wanted > below && aboveRoom > below;
  const maxHeight = Math.max(0, Math.min(wanted, above ? aboveRoom : below));
  const top = above ? anchor.top - gap - maxHeight : anchor.bottom + gap;
  const width = Math.max(list.width, anchor.width);
  const left = Math.max(margin, Math.min(anchor.left, viewport.width - width - margin));
  return { left, top, maxHeight, above };
}
