// Header cells as data (B-044 §2: a click never moves a neighbour). lib/header.tsx draws every
// zone's header from these: each cell is one fixed 32×32 box (the lead 36×36), so a toggle only
// changes icon, tone or pressed state inside its own box, a count badge sits on top of it, and a
// cell a view cannot offer right now stays as an inert placeholder of the same size. A slot cell
// holds a control the frame draws itself (the phone's compact update item, the profile button) in
// the same fixed box, present even while that control shows nothing. The header search swaps the
// title for a field in place; its magnifier is an ordinary cell (id 'search').
// Owns: the cell and search types and their pure rules (badge text, classes, the search cell,
// closing the search, the Back lead). Never: renders, reads stores or touches the DOM.

import type { ComponentChildren } from 'preact';
import type { IconName } from './icons.tsx';
import type { MenuSection } from './popover.tsx';

/** Icon colour of a cell: success = live/joinable, danger = leave/stop, accent = needs a look. */
export type CellTone = 'default' | 'success' | 'danger' | 'accent';

/** Which zone a header belongs to (typography and test hooks only, never geometry). */
export type HeaderZone = 'side' | 'main' | 'pane' | 'phone';

/** A clickable cell: one IconButton in a fixed box. */
export interface HeaderButtonCell {
  /** Stable key and `data-cell` attribute (`.frame-header [data-cell="call"]`). */
  id: string;
  icon: IconName;
  /** aria-label and tooltip; a cell may change it with its state ('Start call' / 'Leave call'). */
  label: string;
  /** Toggle state: background only, aria-pressed. Leave undefined for plain buttons. */
  pressed?: boolean;
  tone?: CellTone;
  /** A count (0 or less = none, above 99 = '99+') or a dot, drawn over the box's corner. */
  badge?: number | 'dot';
  disabled?: boolean;
  /** Working: the icon turns transparent under a spinner, the box stays (disabled meanwhile). */
  busy?: boolean;
  onClick?: (event: MouseEvent) => void;
  /** Opens this menu below the cell instead of calling onClick (named after the cell's label); the cell shows pressed while open. */
  menu?: MenuSection[];
  /** The cell's right-click menu, built when it opens. */
  contextMenu?: () => MenuSection[];
  /** aria-expanded for disclosure toggles (sidebar, workspace); does not change the look. */
  expanded?: boolean;
  /** aria-controls (the id of the region the cell toggles). */
  controls?: string;
  /** Extra classes on the button (test hooks). */
  class?: string;
  /** The box's `data-tour` name (AF-002: the spotlight tour finds the control by it, e.g. 'call-button'). */
  tour?: string;
  placeholder?: false;
}

/** The reserved box of a cell that is not offered right now (same size, inert, not focusable). */
export interface HeaderPlaceholderCell {
  id: string;
  placeholder: true;
}

/** A control the frame draws itself in the same fixed box (shell/MobileShell.tsx: update, profile). */
export interface HeaderSlotCell {
  id: string;
  /** Rendered inside the box; when it renders nothing the box stays (no neighbour moves). */
  slot: ComponentChildren;
  placeholder?: false;
}

export type HeaderCell = HeaderButtonCell | HeaderPlaceholderCell | HeaderSlotCell;

/** The header search: the title swaps to a field of the same height and inset while open. */
export interface HeaderSearchState {
  /** aria-label of the magnifier cell and of the field ('Search chats'). */
  label: string;
  open: boolean;
  query: string;
  onQuery: (query: string) => void;
  onOpenChange: (open: boolean) => void;
  /** Placeholder of the field; 'Search' when left out. */
  placeholder?: string;
  /** Enter in the field. */
  onSubmit?: (query: string) => void;
}

/** Id of the magnifier cell (Header adds it when the view's cells do not place it themselves). */
export const SEARCH_CELL_ID = 'search';

export type BadgeView = { kind: 'dot' } | { kind: 'count'; text: string };

export function isPlaceholder(cell: HeaderCell): cell is HeaderPlaceholderCell {
  return cell.placeholder === true;
}

export function isSlot(cell: HeaderCell): cell is HeaderSlotCell {
  return 'slot' in cell;
}

/** What a cell's badge shows: nothing for no/zero/invalid counts, '99+' above 99, or a dot. */
export function badgeView(badge: number | 'dot' | undefined): BadgeView | null {
  if (badge === 'dot') return { kind: 'dot' };
  if (typeof badge !== 'number' || !Number.isFinite(badge)) return null;
  const count = Math.floor(badge);
  if (count <= 0) return null;
  return { kind: 'count', text: count > 99 ? '99+' : String(count) };
}

/** Classes of a cell's button (IconButton adds `icon-button` and `selected` for pressed itself). */
export function cellClass(cell: HeaderButtonCell): string {
  const parts = ['frame-header-button'];
  if (cell.tone && cell.tone !== 'default') parts.push(`tone-${cell.tone}`);
  if (cell.class) parts.push(cell.class);
  return parts.join(' ');
}

/** Classes of the header root: the zone, a lead column, the reserved sub line and the segments are fixed per view. */
export function headerClass(options: { zone?: HeaderZone; lead?: boolean; twoLine?: boolean; segmented?: boolean; class?: string }): string {
  const parts = ['frame-header', `zone-${options.zone ?? 'main'}`];
  if (options.lead) parts.push('has-lead');
  if (options.twoLine) parts.push('two-line');
  if (options.segmented) parts.push('has-segments'); // distinct from the .segmented toggle control
  if (options.class) parts.push(options.class);
  return parts.join(' ');
}

/** Closes the search: clears the query (the list returns to normal) and closes the field. */
export function closeSearch(search: HeaderSearchState): void {
  if (search.query) search.onQuery('');
  search.onOpenChange(false);
}

/** A Back lead (the phone's pushed screens that draw their own top row: a chat, an agent, a person, Team › Activity). */
export function backCell(onClick: () => void): HeaderButtonCell {
  return { id: 'back', icon: 'arrow-left', label: 'Back', onClick };
}

/** The magnifier cell: pressed while the field is open; a second click closes it. */
export function searchCell(search: HeaderSearchState): HeaderButtonCell {
  return {
    id: SEARCH_CELL_ID, icon: 'magnifying-glass', label: search.label, pressed: search.open,
    onClick: () => { if (search.open) closeSearch(search); else search.onOpenChange(true); },
  };
}

/**
 * The cells as drawn: with a search, its magnifier joins at the right end, unless the view placed
 * a cell with id 'search' itself (`searchCell(search)` at another position, or a placeholder while
 * it offers no search) – then the view's cells stay exactly as given.
 */
export function withSearchCell(cells: readonly HeaderCell[], search: HeaderSearchState | undefined): readonly HeaderCell[] {
  if (!search || cells.some((cell) => cell.id === SEARCH_CELL_ID)) return cells;
  return [...cells, searchCell(search)];
}
