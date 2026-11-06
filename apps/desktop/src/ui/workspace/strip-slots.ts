// The tab strip in numbers (TabStrip.tsx) – pure, so the rules are testable without a window.
// Chrome's strip: the tabs share the room, and nothing shifts under the pointer.
// - placeSlots: places keep their order from render to render. While the strip is held (the pointer on
//   its tabs) a tab that goes keeps its place as an empty slot, so the tab beside it does not slide under
//   the pointer – the next click closes that one too, as in a desktop browser, and a tab that comes joins at
//   the end. Letting go removes them. At rest the places are the list as it stands, so a panel that takes a
//   blank tab's place stays in that place and its neighbours do not slide.
// - cellFit: one width for every tab: the room after "+" shared by the tabs, between MIN_TAB and MAX_TAB
//   (TabStrip.tsx measures it again only while the pointer is off the tabs). When even MIN_TAB tabs do not
//   fit, the view holds whole tabs only and scrolls by whole tabs.
// - revealTarget: the scroll position that shows a tab wholly with the least slide (none when it shows).
// - ROW_ROOM: the strip's room that holds three titled tabs – only then is the global strip the window's title row
//   (Shell.tsx), else the pane's first line under it.
// Owns: these computations. Never: touches the DOM.

/** A place of the strip: a tab, or with `ghost` the room a closed tab leaves while the strip is held. */
export interface Slot { key: string; ghost?: true }

/** The narrowest tab (its icon and its × cell) and the widest (about 24 letters of a title). */
export const MIN_TAB = 48;
export const MAX_TAB = 200;
/** The "+" cell right after the last tab. */
export const NEW_TAB_CELL = 28;
/** A tab with about 8 letters of its title (the strip's one tab width before B-072). */
const TITLED_TAB = 108;
/** Three titled tabs and "+", 2 px apart (TabStrip.tsx): the owner wanted the tabs at the very top "ohne dass es zu eng
 *  kommt vom Platz her", so the global strip lies in the title row only where its room there holds this much. */
export const ROW_ROOM = 3 * TITLED_TAB + 3 * 2 + NEW_TAB_CELL;

export function placeSlots(previous: readonly Slot[], keys: readonly string[], held: boolean): Slot[] {
  if (!held) return keys.map((key) => ({ key }));
  const wanted = new Set(keys);
  const out: Slot[] = [];
  for (const slot of previous) { // a tab that came back takes its own place again
    out.push(wanted.has(slot.key) ? { key: slot.key } : { key: slot.key, ghost: true });
  }
  const placed = new Set(out.map((slot) => slot.key));
  for (const key of keys) if (!placed.has(key)) out.push({ key });
  return out;
}

export function hasGhosts(slots: readonly Slot[]): boolean {
  return slots.some((slot) => slot.ghost);
}

export interface CellFit {
  /** One tab's width. */
  width: number;
  /** The scrolling part's width: exactly `count` whole tabs. */
  view: number;
  /** How many tabs the view holds. */
  count: number;
}

/** The fit of `tabs` tabs in `client` px of room (the tabs, then `gap` and "+"), `gap` px apart. */
export function cellFit(client: number, gap: number, tabs: number): CellFit {
  const room = Math.max(0, client - NEW_TAB_CELL - gap);
  const all = Math.max(1, tabs);
  const shared = Math.floor((room - (all - 1) * gap) / all);
  const count = shared >= MIN_TAB ? all : Math.max(1, Math.floor((room + gap) / (MIN_TAB + gap)));
  const width = Math.max(1, Math.min(MAX_TAB, Math.floor((room - (count - 1) * gap) / count)));
  return { width, count, view: count * width + (count - 1) * gap };
}

/** Where to scroll so that [start, end] shows wholly; `now` when it already does. */
export function revealTarget(start: number, end: number, now: number, client: number, max: number): number {
  if (start >= now - 0.5 && end <= now + client + 0.5) return now;
  const next = end - start > client || start < now ? start : end - client;
  return Math.max(0, Math.min(max, Math.round(next)));
}
