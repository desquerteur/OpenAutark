// B-055 Q5: the feedback tour's pure timeline (src/ui/tour/timeline.ts) – about 40 s in five chapters, time
// clamped and seekable (the same t always gives the same state, in any order), the story in its order (click
// opens and closes the menu, hold shows the waveform, release opens the menu and reveals the transcript word
// by word, the Screenshot tooltip, the editor opened from the thumbnail, the black stroke over the e-mail and
// the phone number, Done, Send, the end card), the cursor on the element it clicks at every click, a hand-like
// path that never jumps, and the end state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPTIONS, CHAPTERS, DURATION, PAINT_PATH, PAINT_SPAN, RIPPLE_MS, SWITCHES, WORDS, clampTime, firstOn, stateAt,
} from '../../../src/ui/tour/timeline.ts';
import {
  CURSOR_START, EDITOR, EDITOR_PART, FEEDBACK_CELL, MENU, MENU_PART, PEN, PRIVATE, SCENE_H, SCENE_W, abs, inside, type Rect,
} from '../../../src/ui/tour/scene-layout.ts';
import type { Point } from '../../../src/shared/model/pointer-motion.ts';

const FRAME = 1000 / 60;
const frames = (from = 0, to = DURATION) => { const out: number[] = []; for (let t = from; t <= to; t += FRAME) out.push(t); return out; };

test('about 40 s in five chapters in order; captions short and in order', () => {
  assert.ok(DURATION >= 32_000 && DURATION <= 45_000, `duration ${DURATION} ms`);
  assert.deepEqual(CHAPTERS.map((chapter) => chapter.title), ['The feedback button', 'Hold to talk', 'Screenshot', 'Paint over', 'Send']);
  assert.equal(CHAPTERS[0]!.at, 0);
  for (let i = 1; i < CHAPTERS.length; i += 1) assert.ok(CHAPTERS[i]!.at > CHAPTERS[i - 1]!.at + 2000, `chapter ${i} starts after the one before`);
  assert.ok(CHAPTERS.at(-1)!.at < DURATION);
  for (let i = 1; i < CAPTIONS.length; i += 1) assert.ok(CAPTIONS[i]!.at >= CAPTIONS[i - 1]!.at);
  for (const caption of CAPTIONS) assert.ok(caption.text.length <= 60 && !/[äöüß]/i.test(caption.text), `short English caption: ${caption.text}`);
  assert.equal(CAPTIONS.at(-1)!.text, '', 'the end card speaks for itself');
});

test('time is clamped and monotonic; stateAt is deterministic and order-free (seekable)', () => {
  assert.equal(stateAt(-500).t, 0);
  assert.equal(stateAt(Number.NaN).t, 0);
  assert.equal(stateAt(DURATION * 3).t, DURATION);
  assert.equal(clampTime(1234.5), 1234.5);
  let last = -1;
  for (const t of frames()) { const now = stateAt(t).t; assert.ok(now >= last); last = now; }
  const times = [0, 1, 2605, 7158.3, 11_000, 18_100, 24_100, 26_000.7, 28_000, 33_800, DURATION - 1, DURATION];
  const forward = times.map((t) => stateAt(t));
  const shuffled = [...times].reverse().map((t) => stateAt(t)).reverse();
  assert.deepEqual(shuffled, forward, 'seeking backwards gives the same pictures');
  assert.deepEqual(stateAt(26_000), stateAt(26_000));
});

test('the poster: the cursor rests in the chat, nothing open, nothing painted', () => {
  const s = stateAt(0);
  assert.deepEqual(s.cursor, CURSOR_START);
  for (const name of SWITCHES) assert.equal(s[name].on, false, name);
  assert.equal(s.words, 0);
  assert.equal(s.paint, 0);
  assert.equal(s.pressed, false);
  assert.equal(s.chapter, 0);
});

test('the story in order: menu, hold, transcript, tooltip, editor, sent, end', () => {
  const order = ['menu', 'wave', 'tooltip', 'editor', 'sent', 'end'] as const;
  for (let i = 1; i < order.length; i += 1) assert.ok(firstOn(order[i]!) > firstOn(order[i - 1]!), `${order[i]} after ${order[i - 1]}`);
  // click → open, click → closed before the hold; the menu is shut while the waveform shows
  const opened = firstOn('menu');
  assert.equal(stateAt(opened + 50).hot, 'feedback', 'the cursor is on the cell when the menu opens');
  assert.equal(stateAt(firstOn('wave') - 300).menu.on, false, 'the second click closed it');
  const holding = stateAt(firstOn('wave') + 500);
  assert.equal(holding.pressed, true, 'held down');
  assert.equal(holding.menu.on, false);
  assert.equal(holding.hot, 'feedback');
  // release: the waveform goes, the menu opens and the words come one by one
  const released = frames(firstOn('wave'), firstOn('tooltip')).find((t) => !stateAt(t).wave.on)!;
  const after = stateAt(released);
  assert.equal(after.menu.on, true);
  assert.equal(after.pressed, false);
  let words = 0;
  for (const t of frames(released, firstOn('tooltip'))) { const now = stateAt(t).words; assert.ok(now >= words); words = now; }
  assert.equal(words, WORDS.length, 'the whole transcript is in before the tooltip');
  assert.ok(frames(released, firstOn('tooltip')).some((t) => { const w = stateAt(t).words; return w > 3 && w < 10; }), 'word by word, not at once');
});

test('the tooltip points at the checked Screenshot box; the editor opens from the thumbnail', () => {
  const tip = stateAt(firstOn('tooltip') + 100);
  assert.equal(tip.hot, 'check');
  assert.equal(tip.menu.on, true);
  assert.ok(stateAt(firstOn('editor') - 1).hot === 'thumb', 'clicked on the thumbnail');
  assert.equal(stateAt(firstOn('editor') + 10).editor.on, true);
});

/** Shortest distance from `point` to the polyline. */
function distance(point: Point, path: readonly Point[]): number {
  let best = Infinity;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]!, b = path[i]!;
    const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
    const k = length ? Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)) : 0;
    best = Math.min(best, Math.hypot(point.x - a.x - k * dx, point.y - a.y - k * dy));
  }
  return best;
}

test('the pen paints along the cursor, pressed, in the editor – and covers the e-mail and the phone number', () => {
  assert.equal(stateAt(PAINT_SPAN.start - 1).paint, 0, 'nothing before the press');
  let count = 0;
  for (const t of frames(PAINT_SPAN.start + 1, PAINT_SPAN.end - 1)) {
    const s = stateAt(t);
    assert.ok(s.pressed && s.editor.on && s.paintTip, `pressed in the editor at ${t}`);
    assert.ok(s.paint >= count);
    count = s.paint;
  }
  assert.equal(stateAt(PAINT_SPAN.end).paint, PAINT_PATH.length, 'the whole stroke once released');
  assert.equal(stateAt(PAINT_SPAN.end).paintTip, null);
  for (const rect of [PRIVATE.email, PRIVATE.phone] as Rect[]) {
    for (let x = rect.x; x <= rect.x + rect.w; x += 2) {
      for (let y = rect.y + 2; y <= rect.y + rect.h - 2; y += 1) {
        assert.ok(distance({ x, y }, PAINT_PATH) <= PEN / 2, `(${x}, ${y}) is under the black stroke`);
      }
    }
  }
});

test('Done closes the editor, Send sends, then the end card; every click lands on its element', () => {
  const closed = frames(firstOn('editor') + 1000).find((t) => !stateAt(t).editor.on)!;
  assert.ok(inside(stateAt(closed).cursor, abs(EDITOR_PART.done, EDITOR)), 'Done was clicked');
  assert.equal(stateAt(closed + 200).paint, PAINT_PATH.length, 'the thumbnail keeps the painted picture');
  assert.ok(inside(stateAt(firstOn('sent')).cursor, abs(MENU_PART.send, MENU)), 'Send was clicked');
  for (const t of frames()) {
    const s = stateAt(t);
    if (s.ripple && s.ripple.age < FRAME) {
      assert.ok(s.ripple.age < RIPPLE_MS);
      // just before the press ends, while what it opens or closes has not changed yet
      assert.ok(stateAt(t - s.ripple.age - 1).hot !== null, `the click at ${Math.round(t - s.ripple.age)} lands on an element`);
    }
  }
  const end = stateAt(DURATION);
  assert.equal(end.end.on, true);
  assert.equal(end.menu.on, false);
  assert.equal(end.editor.on, false);
  assert.equal(end.sent.on, true);
  assert.equal(end.words, WORDS.length);
  assert.equal(end.caption, '');
  assert.equal(end.chapter, CHAPTERS.length - 1);
  assert.equal(stateAt(firstOn('end') - 1).end.on, false);
});

test('the cursor moves like a hand: inside the scene, never a jump between two frames, a visible glide to the cell', () => {
  let previous = stateAt(0).cursor;
  let longest = 0;
  for (const t of frames()) {
    const { cursor } = stateAt(t);
    assert.ok(cursor.x >= 0 && cursor.x <= SCENE_W && cursor.y >= 0 && cursor.y <= SCENE_H, `inside the scene at ${t}`);
    longest = Math.max(longest, Math.hypot(cursor.x - previous.x, cursor.y - previous.y));
    previous = cursor;
  }
  assert.ok(longest < 40, `at most ${longest.toFixed(1)} units per frame`);
  const reach = frames(0, firstOn('menu')).find((t) => inside(stateAt(t).cursor, FEEDBACK_CELL))!;
  assert.ok(reach > 1700, `the first glide takes its time (on the cell at ${Math.round(reach)} ms)`);
});
