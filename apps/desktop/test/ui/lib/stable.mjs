// Layout stability for window tests (B-044 §2: a click never moves a neighbour). expectStable
// measures the box of the first element matching each selector (getBoundingClientRect – the
// same box as Playwright's boundingBox() for the main frame, read in one frame without auto-wait),
// runs the action, waits two animation frames (at most 150 ms) and throws one readable error that lists every
// element that moved, resized or disappeared.
//   await expectStable(page, ['.sidebar .frame-header-title', '.sidebar [data-cell="search"]', '.chat-rows'],
//     () => page.getByRole('button', { name: 'Search chats' }).click());
// Measure boxes that stay: the open search replaces the title's <h2> with its field (lib/header.tsx),
// so the title track (.frame-header-title) is the box to compare, not the h2 (that one "disappeared").
// Owns: the before/after comparison. Never: clicks, navigates or waits for the app itself (the action does).

/** Box of the first element per selector (null when nothing matches), measured in one go. */
export async function measureBoxes(page, selectors) {
  return page.evaluate((list) => list.map((selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }), [...selectors]);
}

const round = (value) => Math.round(value * 10) / 10;
const signed = (value) => `${value > 0 ? '+' : ''}${round(value)}`;

/** One line per selector whose box changed by more than `tolerance` px (pure, for the error text). */
export function layoutChanges(selectors, before, after, tolerance = 0.5) {
  const lines = [];
  selectors.forEach((selector, index) => {
    const a = before[index];
    const b = after[index];
    if (!a && !b) return;
    if (!b) { lines.push(`${selector}: disappeared`); return; }
    if (!a) { lines.push(`${selector}: appeared`); return; }
    const moved = ['x', 'y', 'width', 'height']
      .filter((key) => Math.abs(b[key] - a[key]) > tolerance)
      .map((key) => `${key} ${round(a[key])} -> ${round(b[key])} (${signed(b[key] - a[key])})`);
    if (moved.length) lines.push(`${selector}: ${moved.join(', ')}`);
  });
  return lines;
}

/**
 * Runs `action` and fails when any of `selectors` moved or resized by more than `tolerance` px.
 * Every selector must match before the action. Returns both measurements.
 */
export async function expectStable(page, selectors, action, { tolerance = 0.5 } = {}) {
  const list = [...selectors];
  const before = await measureBoxes(page, list);
  const missing = list.filter((_, index) => !before[index]);
  if (missing.length) throw new Error(`expectStable: not found before the action: ${missing.join(', ')}`);
  await action();
  // two frames for renders and effects; a window that does not paint (hidden) gets 150 ms instead
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
    setTimeout(() => resolve(true), 150);
  }));
  const after = await measureBoxes(page, list);
  const changes = layoutChanges(list, before, after, tolerance);
  if (changes.length) {
    throw new Error(`expectStable: ${changes.length} of ${list.length} element(s) moved (tolerance ${tolerance} px):\n  ${changes.join('\n  ')}`);
  }
  return { before, after };
}
