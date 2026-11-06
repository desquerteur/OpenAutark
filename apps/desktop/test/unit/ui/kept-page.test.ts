// The kept page's floor against the real numbers of a 175 % display. The window tests run at this PC's display scale, where
// clientHeight happens to round harmlessly, so they cannot see this one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keptPage } from '../../../src/ui/lib/kept-page.ts';

/** A scroller 755.43 px high (clientHeight says 755), scrolled to `scrollTop`, with its page's floor. */
function scrolled(scrollTop: number, minHeight: string) {
  const page = { style: { minHeight } };
  const scroller = { firstElementChild: page, scrollTop, clientHeight: 755, getBoundingClientRect: () => ({ height: 755.43 }) };
  keptPage.onScroll({ currentTarget: scroller } as unknown as Event);
  return page.style.minHeight;
}

test('the floor comes down to the end of the view, never a fraction short of it (the browser would scroll, and again)', () => {
  const floor = parseFloat(scrolled(313.71, '1100px'));
  assert.ok(floor >= 313.71 + 755.43, `floor ${floor}`);
  assert.ok(floor < 313.71 + 755.43 + 1, `floor ${floor}`);
});

test('scrolling never raises the floor, and a page without one stays without', () => {
  assert.equal(scrolled(313.71, '900px'), '900px');
  assert.equal(scrolled(313.71, ''), '');
});
