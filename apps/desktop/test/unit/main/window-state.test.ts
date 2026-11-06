import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_HEIGHT, DEFAULT_WIDTH, MIN_HEIGHT, MIN_WIDTH, clampBounds, loadWindowState, parseWindowState, saveWindowState,
} from '../../../src/main/window-state.ts';

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };
const SECOND = { x: 1920, y: 0, width: 1280, height: 984 };

test('no saved bounds: default size centered on the primary display', () => {
  const bounds = clampBounds(undefined, [PRIMARY], PRIMARY);
  assert.equal(bounds.width, DEFAULT_WIDTH);
  assert.equal(bounds.height, DEFAULT_HEIGHT);
  assert.equal(bounds.x, (PRIMARY.width - DEFAULT_WIDTH) / 2);
});

test('bounds on a monitor that is gone are re-centered on the primary display', () => {
  const bounds = clampBounds({ x: 3500, y: 200, width: 900, height: 700 }, [PRIMARY], PRIMARY);
  assert.deepEqual(bounds, { x: 510, y: 170, width: 900, height: 700 });
});

test('partly off-screen windows are pulled in; oversized ones shrink to the work area', () => {
  assert.deepEqual(clampBounds({ x: -300, y: 900, width: 1000, height: 700 }, [PRIMARY], PRIMARY), { x: 0, y: 340, width: 1000, height: 700 });
  assert.deepEqual(clampBounds({ x: 1950, y: 10, width: 2500, height: 1500 }, [PRIMARY, SECOND], PRIMARY), { ...SECOND });
});

test('the minimum window size is enforced', () => {
  const bounds = clampBounds({ x: 100, y: 100, width: 200, height: 100 }, [PRIMARY], PRIMARY);
  assert.equal(bounds.width, MIN_WIDTH);
  assert.equal(bounds.height, MIN_HEIGHT);
});

test('the window lands on the display it overlaps most', () => {
  const bounds = clampBounds({ x: 1800, y: 100, width: 1000, height: 600 }, [PRIMARY, SECOND], PRIMARY);
  assert.equal(bounds.x, 1920, 'moved fully onto the second display');
  assert.equal(bounds.width, 1000);
});

test('parse is tolerant and never throws', () => {
  assert.deepEqual(parseWindowState(null), { bounds: undefined, maximized: false });
  assert.deepEqual(parseWindowState({ bounds: { x: 'a', y: 0, width: 1, height: 1 }, maximized: 'yes', theme: 'neon' }), { bounds: undefined, maximized: false });
  assert.deepEqual(parseWindowState({ bounds: { x: 10.4, y: 20, width: 800, height: 600 }, maximized: true, theme: 'dark' }), {
    bounds: { x: 10, y: 20, width: 800, height: 600 }, maximized: true, theme: 'dark',
  });
});

test('save + load round trip; a corrupt file means defaults', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-window-'));
  try {
    const file = path.join(dir, 'window-state.json');
    await saveWindowState(file, { bounds: { x: 1, y: 2, width: 900, height: 700 }, maximized: false, theme: 'light' });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).theme, 'light');
    assert.deepEqual(await loadWindowState(file), { bounds: { x: 1, y: 2, width: 900, height: 700 }, maximized: false, theme: 'light' });
    writeFileSync(file, '{not json');
    assert.deepEqual(await loadWindowState(file), { bounds: undefined, maximized: false });
    assert.deepEqual(await loadWindowState(path.join(dir, 'missing.json')), { bounds: undefined, maximized: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent saves are serialized: the last call wins, no temp file is left behind', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-window-'));
  try {
    const file = path.join(dir, 'window-state.json');
    await Promise.all([1, 2, 3, 4, 5].map(x => saveWindowState(file, { bounds: { x, y: 0, width: 900, height: 700 }, maximized: x === 5 })));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { bounds: { x: 5, y: 0, width: 900, height: 700 }, maximized: true });
    assert.deepEqual(readdirSync(dir), ['window-state.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
