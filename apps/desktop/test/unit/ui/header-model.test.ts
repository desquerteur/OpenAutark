// B-044 header cells as data (ui/lib/header-model.ts, drawn by lib/header.tsx): badge text,
// classes of the fixed boxes, placeholders, and the in-place search (magnifier cell keeps its
// place, a second click or closing clears the query) and slot cells (a control the frame draws in
// the same box: the phone's update item and profile).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_CELL_ID, badgeView, cellClass, closeSearch, headerClass, isPlaceholder, isSlot, searchCell, withSearchCell,
} from '../../../src/ui/lib/header-model.ts';
import type { HeaderButtonCell, HeaderCell, HeaderSearchState } from '../../../src/ui/lib/header-model.ts';

function search(open: boolean, query = ''): HeaderSearchState & { calls: string[] } {
  const calls: string[] = [];
  return {
    label: 'Search chats', open, query, calls,
    onQuery: (value) => { calls.push(`query:${value}`); },
    onOpenChange: (value) => { calls.push(`open:${value}`); },
  };
}

test('badges: nothing for no, zero or invalid counts, 99+ above 99, or a dot', () => {
  for (const none of [undefined, 0, -3, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(badgeView(none), null, String(none));
  assert.deepEqual(badgeView(3), { kind: 'count', text: '3' });
  assert.deepEqual(badgeView(3.7), { kind: 'count', text: '3' });
  assert.deepEqual(badgeView(99), { kind: 'count', text: '99' });
  assert.deepEqual(badgeView(140), { kind: 'count', text: '99+' });
  assert.deepEqual(badgeView('dot'), { kind: 'dot' });
});

test('classes: the zone, a lead and the reserved sub line are fixed per header; tones only colour the button', () => {
  assert.equal(headerClass({}), 'frame-header zone-main');
  assert.equal(headerClass({ zone: 'side', lead: true, twoLine: true, class: 'chat-header' }), 'frame-header zone-side has-lead two-line chat-header');
  const call: HeaderButtonCell = { id: 'call', icon: 'phone', label: 'Start call' };
  assert.equal(cellClass(call), 'frame-header-button');
  assert.equal(cellClass({ ...call, tone: 'default' }), 'frame-header-button');
  assert.equal(cellClass({ ...call, icon: 'phone-disconnect', label: 'Leave call', tone: 'danger', class: 'call-cell' }), 'frame-header-button tone-danger call-cell');
  assert.equal(isPlaceholder({ id: 'call', placeholder: true }), true);
  assert.equal(isPlaceholder(call), false);
});

test('search: the magnifier is pressed while open, a second click closes and clears the query', () => {
  const closed = search(false);
  const cell = searchCell(closed);
  assert.equal(cell.id, SEARCH_CELL_ID);
  assert.equal(cell.icon, 'magnifying-glass');
  assert.equal(cell.label, 'Search chats');
  assert.equal(cell.pressed, false);
  cell.onClick?.(new Event('click') as MouseEvent);
  assert.deepEqual(closed.calls, ['open:true']);

  const open = search(true, 'mira');
  const pressed = searchCell(open);
  assert.equal(pressed.pressed, true);
  pressed.onClick?.(new Event('click') as MouseEvent);
  assert.deepEqual(open.calls, ['query:', 'open:false']);

  const empty = search(true);
  closeSearch(empty);
  assert.deepEqual(empty.calls, ['open:false'], 'an empty query is not cleared again');
});

test('search cell placement: added at the right end, or kept where the view placed it (also as a placeholder)', () => {
  const add: HeaderCell = { id: 'new', icon: 'plus', label: 'New chat' };
  const state = search(false);
  assert.deepEqual(withSearchCell([add], undefined), [add], 'no search, no magnifier');
  const appended = withSearchCell([add], state);
  assert.deepEqual(appended.map((cell) => cell.id), ['new', SEARCH_CELL_ID]);
  const placed = [searchCell(state), add];
  assert.equal(withSearchCell(placed, state), placed, 'the view placed it first');
  const reserved: HeaderCell[] = [add, { id: SEARCH_CELL_ID, placeholder: true }];
  assert.equal(withSearchCell(reserved, state), reserved, 'a reserved box stays a placeholder');
});

test('a slot cell is its own kind: no placeholder, no button, the search still joins after it', () => {
  const update: HeaderCell = { id: 'update', slot: null };
  assert.equal(isSlot(update), true);
  assert.equal(isPlaceholder(update), false);
  assert.equal(isSlot({ id: 'search', placeholder: true }), false);
  assert.equal(isSlot(searchCell(search(false))), false);
  assert.deepEqual(withSearchCell([update], search(false)).map((cell) => cell.id), ['update', SEARCH_CELL_ID]);
});
