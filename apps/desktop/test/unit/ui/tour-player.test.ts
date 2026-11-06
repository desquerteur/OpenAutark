// B-055 Q5: the tour player's pure rules (src/ui/tour/player-model.ts) – the time label, the keys (Space only
// off a button, K, ←/→ 5 s, Home/End), the scrubber's time under a point, the fit of the 960 × 600 scene and a
// frame step that never jumps after a pause – and the tour's isolation: no file under src/ui/tour imports a
// live component, store, router or RPC (only its own files, shared models and preact), so rebuilding the live
// UI never breaks the tour and the tour never touches live operation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MAX_FRAME_MS, STEP_MS, fitScale, formatTime, keyAction, nextTime, stepTime, timeAt } from '../../../src/ui/tour/player-model.ts';

const TOUR = path.resolve(import.meta.dirname, '../../../src/ui/tour');

test('the time label', () => {
  assert.deepEqual([formatTime(0), formatTime(999), formatTime(7_400), formatTime(38_800), formatTime(61_000), formatTime(-5)], ['0:00', '0:00', '0:07', '0:38', '1:01', '0:00']);
});

test('keys: Space toggles off a button, K toggles, arrows step 5 s, Home and End jump', () => {
  assert.equal(keyAction(' ', false), 'toggle');
  assert.equal(keyAction(' ', true), null, "a focused button's own Space presses it");
  assert.equal(keyAction('k', true), 'toggle');
  assert.deepEqual(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'x'].map((key) => keyAction(key, true)), ['back', 'forward', 'start', 'end', null]);
  assert.equal(STEP_MS, 5000);
  assert.deepEqual([stepTime('back', 12_000, 40_000), stepTime('back', 3_000, 40_000), stepTime('forward', 38_000, 40_000), stepTime('start', 9, 40_000), stepTime('end', 9, 40_000)], [7_000, 0, 40_000, 0, 40_000]);
});

test('the scrubber: the time under a point, clamped to the tour', () => {
  assert.equal(timeAt(150, 100, 200, 40_000), 10_000);
  assert.equal(timeAt(50, 100, 200, 40_000), 0);
  assert.equal(timeAt(900, 100, 200, 40_000), 40_000);
  assert.equal(timeAt(150, 100, 0, 40_000), 0, 'a scrubber without width');
});

test('the scene fits its box at every size and keeps its aspect', () => {
  assert.equal(fitScale(960, 600), 1);
  assert.equal(fitScale(480, 600), 0.5, 'narrow: the width decides');
  assert.equal(fitScale(1920, 300), 0.5, 'low: the height decides');
  assert.equal(fitScale(4000, 4000), 1.6, 'never blown up past the cap');
  assert.equal(fitScale(0, 300), 0);
  const phone = fitScale(388, 243);
  assert.ok(phone > 0.39 && phone < 0.41, 'phone width');
});

test('a frame never jumps the tour: long gaps step at most MAX_FRAME_MS, never past the end', () => {
  assert.equal(nextTime(1000, 16, 40_000), 1016);
  assert.equal(nextTime(1000, 5000, 40_000), 1000 + MAX_FRAME_MS, 'after a hidden window or a busy PC');
  assert.equal(nextTime(39_990, 50, 40_000), 40_000);
  assert.equal(nextTime(1000, -20, 40_000), 1000);
});

test('the tour imports nothing of the live app: only its own files, shared models and preact', () => {
  const files = readdirSync(TOUR).filter((name) => /\.tsx?$/.test(name));
  assert.ok(files.includes('Scene.tsx') && files.includes('timeline.ts') && files.includes('TourPlayer.tsx'));
  for (const file of files) {
    const source = readFileSync(path.join(TOUR, file), 'utf8');
    for (const [, from] of source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      const allowed = from!.startsWith('./') || from!.startsWith('../../shared/model/') || /^preact(\/|$)|^@preact\/signals$/.test(from!);
      assert.ok(allowed, `${file} imports ${from}`);
    }
    assert.doesNotMatch(source, /\brpc\.|window\.workforce|fetch\(/, `${file} calls nothing`);
  }
});
