// One header for every zone: the side nav headings, the main view headers, the workspace pane header and the
// phone top row. A CSS grid of fixed tracks at the row height (--header-h, styles/header.css):
//     [lead 36px | 0] [title minmax(0, 1fr)] [cells n × 32px] [caption var(--caption-space)]
// Views hand over data, never header markup: a title (a string becomes the zone's <h2>, a node is placed as
// given), an optional sub line that is ALWAYS reserved when the header declares `twoLine`, an optional lead
// cell and the cells (header-model.ts HeaderCell: fixed 32×32 boxes; a placeholder keeps its box inert).
// A segmented header (`near` or `panel`, the chat's row) has a title track of one fixed width, the `near`
// cells right after it (so they never move with the title's text), then a free track holding the open
// side panel's name and its X above that panel, then the cells and the caption room:
//     [lead] [title fixed] [near cells] [panel: name · X – 1fr] [cells] [caption]
// `search` swaps the title in place for a field of the same height (HeaderSearch).
// Owns: header markup, the cell buttons and their menus, the in-place search field.
// Never: decides which cells a view has, reads stores, or sets the caption reserve.

import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useContextMenu } from './context-menu.tsx';
import { IconButton, Menu, Spinner } from './ui.tsx';
import {
  SEARCH_CELL_ID, badgeView, cellClass, closeSearch, headerClass, isPlaceholder, isSlot, withSearchCell,
} from './header-model.ts';
import type { HeaderButtonCell, HeaderCell, HeaderSearchState, HeaderZone } from './header-model.ts';

export type { CellTone, HeaderButtonCell, HeaderCell, HeaderPlaceholderCell, HeaderSearchState, HeaderSlotCell, HeaderZone } from './header-model.ts';
export { SEARCH_CELL_ID, backCell, closeSearch, searchCell } from './header-model.ts';

export interface HeaderProps {
  /** A string or number becomes the zone's heading (<h2>); any other node is placed as given. */
  title: ComponentChildren;
  /** The second line (12 px, muted); drawn only in a `twoLine` header. */
  sub?: ComponentChildren;
  /** Reserve the sub line always (title 20 px + sub 16 px), so the title never moves. */
  twoLine?: boolean;
  /** The 36 px cell before the title (back, sidebar toggle); without it the lead track is 0. */
  lead?: HeaderCell;
  /** The fixed 32 px cells, left to right (at the row's end). */
  cells?: readonly HeaderCell[];
  /** Cells right after the fixed-width title track (the chat's Call, Browser, Tasks). */
  near?: readonly HeaderCell[];
  /** The open side panel's name and its close button, above the panel. */
  panel?: { title: string; onClose: () => void };
  /** While open the title is the search field; its magnifier joins the cells (right end) unless placed. */
  search?: HeaderSearchState;
  /** Typography and test hooks: side 17 px/600, phone 20 px/600, main and pane 14 px/500. */
  zone?: HeaderZone;
  class?: string;
}

export function Header(props: HeaderProps) {
  const cells = withSearchCell(props.cells ?? [], props.search);
  const zone = props.zone ?? 'main';
  const title = typeof props.title === 'string' || typeof props.title === 'number'
    ? <h2 class="frame-header-text">{props.title}</h2>
    : props.title;
  const segmented = props.near !== undefined || props.panel !== undefined;
  return (
    <header class={headerClass({ zone, lead: !!props.lead, twoLine: props.twoLine, segmented, class: props.class })} data-zone={zone}>
      {props.lead && <Cell cell={props.lead} lead />}
      <div class="frame-header-title">
        {props.search?.open ? <HeaderSearch {...props.search} /> : (
          <>
            <div class="frame-header-line">{title}</div>
            {props.twoLine && <div class="frame-header-sub">{props.sub}</div>}
          </>
        )}
      </div>
      {segmented && (
        <>
          <div class="frame-header-cells frame-header-near">
            {(props.near ?? []).map((cell) => <Cell key={cell.id} cell={cell} />)}
          </div>
          <div class="frame-header-panel">
            {props.panel && (
              <>
                <h3 class="frame-header-panel-title">{props.panel.title}</h3>
                <IconButton icon="x" label={`Close ${props.panel.title.toLowerCase()}`} size="small" class="frame-header-panel-close" onClick={props.panel.onClose} />
              </>
            )}
          </div>
        </>
      )}
      <div class="frame-header-cells frame-header-end">
        {cells.map((cell) => <Cell key={cell.id} cell={cell} />)}
      </div>
    </header>
  );
}

function Cell(props: { cell: HeaderCell; lead?: boolean }) {
  const box = `frame-header-cell${props.lead ? ' frame-header-lead' : ''}`;
  if (isPlaceholder(props.cell)) return <span class={`${box} placeholder`} data-cell={props.cell.id} aria-hidden="true" />;
  if (isSlot(props.cell)) return <span class={`${box} slot`} data-cell={props.cell.id}>{props.cell.slot}</span>;
  return <ButtonCell cell={props.cell} box={box} lead={props.lead} />;
}

const NO_MENU = () => [];

function ButtonCell(props: { cell: HeaderButtonCell; box: string; lead?: boolean }) {
  const { cell } = props;
  const context = useContextMenu(cell.contextMenu ?? NO_MENU);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const badge = badgeView(cell.badge);
  const menuOpen = !!cell.menu && menuAnchor !== null;
  const onClick = (event: MouseEvent) => {
    if (cell.menu) setMenuAnchor(menuAnchor ? null : event.currentTarget as HTMLElement);
    else cell.onClick?.(event);
  };
  return (
    <span class={`${props.box}${cell.busy ? ' busy' : ''}`} data-cell={cell.id} {...(cell.contextMenu ? context : {})}>
      <IconButton
        icon={cell.icon} label={cell.label} iconSize={props.lead ? 20 : 18}
        pressed={cell.menu ? undefined : cell.pressed}
        class={`${cellClass(cell)}${menuOpen ? ' selected' : ''}`}
        disabled={cell.disabled || cell.busy}
        aria-busy={cell.busy || undefined}
        aria-expanded={cell.menu ? menuOpen : cell.expanded}
        aria-haspopup={cell.menu ? 'menu' : undefined}
        aria-controls={cell.controls}
        onClick={onClick}
      />
      {cell.busy && <span class="frame-header-spin"><Spinner size={16} /></span>}
      {badge && <span class={`frame-header-badge${badge.kind === 'dot' ? ' dot' : ' tabular'}`} aria-hidden="true">{badge.kind === 'count' ? badge.text : null}</span>}
      {cell.menu && <Menu anchor={menuAnchor} open={menuOpen} onClose={() => setMenuAnchor(null)} placement="bottom-end" label={cell.label} sections={cell.menu} class="frame-header-menu" />}
    </span>
  );
}

/**
 * The search field that takes the title's place (same height and text inset). It focuses itself
 * without scrolling; Esc closes (query cleared) and gives the focus back to the magnifier. With a
 * query an ✕ inside the field's reserved right end clears it (the phone's field has the same).
 */
export function HeaderSearch(props: HeaderSearchState) {
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { input.current?.focus({ preventScroll: true }); }, []);
  const close = () => {
    const magnifier = input.current?.closest('.frame-header')?.querySelector<HTMLButtonElement>(`[data-cell="${SEARCH_CELL_ID}"] button`);
    closeSearch(props);
    magnifier?.focus({ preventScroll: true });
  };
  const clear = () => { props.onQuery(''); input.current?.focus({ preventScroll: true }); };
  return (
    <span class="frame-header-search-box">
      <input
        ref={input} class="frame-header-search" type="search" value={props.query} aria-label={props.label}
        placeholder={props.placeholder ?? 'Search'} autocomplete="off" spellcheck={false}
        onInput={(event) => props.onQuery((event.currentTarget as HTMLInputElement).value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
          else if (event.key === 'Enter') props.onSubmit?.(props.query);
        }}
      />
      {props.query && <IconButton icon="x" label="Clear search" size="small" iconSize={12} class="frame-header-search-clear" onClick={clear} />}
    </span>
  );
}
