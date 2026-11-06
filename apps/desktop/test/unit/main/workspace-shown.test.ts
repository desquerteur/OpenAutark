// One shown website per space (main/workspace-shown.ts): the global pane and a chat's area each show a tab at the same
// time, a show replaces only its own space's tab, a hide takes one tab off and leaves the other, a window resize takes
// all off, a failed page stays hidden on its slot, the memory saver keeps the last tabs of the two spaces shown last,
// a box is fitted into the window below its title row, and a tab on its slot paints only while its window is on screen.
// Owns: these assertions only. Never: Electron or real views.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShownTabs, fit, type SlotTab } from '../../../src/main/workspace-shown.ts';
import type { BrowserBounds } from '../../../src/shared/api/workspace-browser.ts';

const PANE: BrowserBounds = { x: 900, y: 96, width: 380, height: 600 };
const AREA: BrowserBounds = { x: 240, y: 96, width: 640, height: 300 };

/** Views that remember where they were put. */
function views(ids: string[]): Map<string, SlotTab & { box?: BrowserBounds; visible: boolean }> {
  return new Map(ids.map((id) => {
    const tab = { visible: false, box: undefined as BrowserBounds | undefined, error: undefined as string | undefined,
      view: { setBounds: (box: BrowserBounds) => { tab.box = box; }, setVisible: (visible: boolean) => { tab.visible = visible; } } };
    return [id, tab] as const;
  }));
}

function arranged(slots: ShownTabs, tabs: ReturnType<typeof views>): Record<string, boolean> {
  const seen: Record<string, boolean> = {};
  slots.arrange(tabs, (id, shown) => { seen[id] = shown; });
  return seen;
}

test('two spaces show a tab at once, each on its own slot; every other tab is hidden', () => {
  const slots = new ShownTabs();
  const tabs = views(['web-g', 'web-c', 'web-x']);
  slots.show('global', 'web-g', PANE);
  slots.show('chat:c1', 'web-c', AREA);
  assert.equal(slots.shownIn('global'), 'web-g');
  assert.equal(slots.shownIn('chat:c1'), 'web-c');
  assert.equal(slots.shownIn('chat:c2'), null, 'a space that showed nothing');
  assert.ok(slots.isShown('web-g') && slots.isShown('web-c') && !slots.isShown('web-x'));
  assert.deepEqual(arranged(slots, tabs), { 'web-g': true, 'web-c': true, 'web-x': false }, 'the memory saver hears each');
  assert.deepEqual([tabs.get('web-g')!.visible, tabs.get('web-g')!.box], [true, PANE]);
  assert.deepEqual([tabs.get('web-c')!.visible, tabs.get('web-c')!.box], [true, AREA]);
  assert.equal(tabs.get('web-x')!.visible, false);
});

test('a show replaces only the tab of its own space', () => {
  const slots = new ShownTabs();
  const tabs = views(['web-g', 'web-g2', 'web-c']);
  slots.show('global', 'web-g', PANE);
  slots.show('chat:c1', 'web-c', AREA);
  slots.show('global', 'web-g2', { ...PANE, height: 500 });
  assert.equal(slots.shownIn('global'), 'web-g2');
  assert.equal(slots.shownIn('chat:c1'), 'web-c', 'the chat area keeps its tab');
  arranged(slots, tabs);
  assert.deepEqual(['web-g', 'web-g2', 'web-c'].map((id) => tabs.get(id)!.visible), [false, true, true]);
  assert.equal(tabs.get('web-g2')!.box!.height, 500);
  slots.show('chat:c1', 'web-g2', AREA);
  assert.deepEqual([slots.shownIn('global'), slots.shownIn('chat:c1')], [null, 'web-g2'], 'a tab moved to another space leaves its old slot');
});

test('a hide takes one tab off and leaves the other; a window resize takes all off; a failed page stays hidden', () => {
  const slots = new ShownTabs();
  const tabs = views(['web-g', 'web-c']);
  slots.show('global', 'web-g', PANE);
  slots.show('chat:c1', 'web-c', AREA);
  assert.deepEqual(slots.hide('web-c'), ['web-c']);
  assert.deepEqual(slots.hide('web-c'), [], 'it is on no slot any more');
  assert.deepEqual(slots.hide('web-x'), [], 'a tab that was never shown');
  assert.equal(slots.shownIn('chat:c1'), null);
  assert.equal(slots.shownIn('global'), 'web-g', 'the pane keeps its page');
  arranged(slots, tabs);
  assert.deepEqual([tabs.get('web-g')!.visible, tabs.get('web-c')!.visible], [true, false]);
  assert.deepEqual(slots.boundsFor('chat:c1'), AREA, 'the slot keeps its box for the next show and new pages');
  slots.show('chat:c1', 'web-c', AREA);
  assert.deepEqual(slots.hide().sort(), ['web-c', 'web-g']);
  assert.ok(!slots.isShown('web-g') && !slots.isShown('web-c'));
  slots.show('global', 'web-g', PANE);
  tabs.get('web-g')!.error = 'This page could not be loaded.';
  arranged(slots, tabs);
  assert.deepEqual([tabs.get('web-g')!.visible, tabs.get('web-g')!.box], [false, PANE], 'on its slot, but its page failed');
});

test('the memory saver keeps the shown tabs and the last tabs of the two spaces shown last; a gone window leaves no slot', () => {
  const slots = new ShownTabs();
  slots.show('global', 'web-g', PANE);
  slots.show('chat:c1', 'web-c1', AREA);
  slots.hide();
  assert.ok(slots.kept('web-g') && slots.kept('web-c1'), 'off their slots for a moment (a resize, a menu over them)');
  slots.show('chat:c2', 'web-c2', AREA);
  slots.hide('web-c2');
  assert.ok(!slots.kept('web-g'), 'the pane showed longest ago');
  assert.ok(slots.kept('web-c1') && slots.kept('web-c2'));
  slots.show('global', 'web-g', PANE);
  assert.ok(slots.kept('web-g') && slots.kept('web-c2') && !slots.kept('web-c1'));
  assert.ok(!slots.kept('web-x'));
  slots.clear();
  assert.ok(!slots.kept('web-g') && !slots.isShown('web-g'));
  assert.deepEqual(slots.boundsFor('chat:c9'), PANE, 'a space without a slot sizes new pages like the slot shown last');
  assert.deepEqual(new ShownTabs().boundsFor('global'), { x: 0, y: 48, width: 1280, height: 800 }, 'before any slot');
});

test('a box fits into the window in whole pixels, below the title row', () => {
  assert.deepEqual(fit({ x: 10.4, y: 96.6, width: 300.2, height: 200.5 }, 1280, 800), { x: 10, y: 97, width: 300, height: 201 });
  assert.deepEqual(fit({ x: -5, y: 0, width: 2000, height: 2000 }, 1280, 800), { x: 0, y: 48, width: 1280, height: 752 });
  assert.deepEqual(fit({ x: 1300, y: 900, width: 50, height: 50 }, 1280, 800), { x: 1279, y: 799, width: 1, height: 1 });
});

test('B-076: a tab on its slot paints only while its window is on screen – minimized or hidden, a watcher needs the host', () => {
  const slots = new ShownTabs();
  slots.show('global', 'web-g', PANE);
  const window = { visible: true, minimized: false, isVisible() { return this.visible; }, isMinimized() { return this.minimized; } };
  assert.equal(slots.painted('web-g', window), true);
  window.minimized = true;
  assert.equal(slots.isShown('web-g'), true, 'a minimized window keeps its slots on (nothing hides them)');
  assert.equal(slots.painted('web-g', window), false, 'but it draws nothing');
  window.minimized = false;
  window.visible = false;
  assert.equal(slots.painted('web-g', window), false, 'hidden to the tray');
  window.visible = true;
  assert.equal(slots.painted('web-x', window), false, 'not on a slot');
  assert.equal(slots.painted('web-g', null), false, 'no window');
});
