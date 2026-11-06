// <data>/theme.css (root/theme.ts): read as it is ('' when missing or too large), every change – also deleting
// it – emits 'theme.updated' with the text, and the old overlay's custom/theme.css moves there once.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { THEME_MAX_BYTES, readTheme, watchTheme } from '../../../src/runtime/root/theme.ts';
import { RootWatcher } from '../../../src/runtime/root/watcher.ts';
import { ROOT_THEME } from '../../../src/runtime/root/layout.ts';
import { clock, recordingBus, tempDir } from '../store/helpers.ts';

test('theme.css: read as written, a change or its removal is announced with the text', (t) => {
  const temp = tempDir('wf-theme-');
  const root = new RootWatcher({ root: temp.dir, clock: clock(), watch: false, debounceMs: 1, maxWaitMs: 5 });
  root.start();
  t.after(() => { root.stop(); temp.cleanup(); });
  const recorder = recordingBus();
  const stop = watchTheme({ dataDir: temp.dir, root, bus: recorder.bus });
  const file = path.join(temp.dir, ROOT_THEME);
  assert.equal(readTheme(temp.dir), '');
  const changed = () => { root.nudge(ROOT_THEME); root.flush(ROOT_THEME); };
  writeFileSync(file, ':root { --surface: #fff8e7; }\r\n');
  changed();
  assert.deepEqual(recorder.of('theme.updated'), [{ css: ':root { --surface: #fff8e7; }' }]);
  rmSync(file);
  changed();
  assert.deepEqual(recorder.of('theme.updated').at(-1), { css: '' }, 'deleting it brings the shipped look back');
  writeFileSync(file, 'x'.repeat(THEME_MAX_BYTES + 1));
  assert.equal(readTheme(temp.dir), '', 'a file too large is not applied');
  stop();
});

test('the old overlay theme moves to <data>/theme.css once (never over an existing one)', (t) => {
  const temp = tempDir('wf-theme-move-');
  t.after(temp.cleanup);
  mkdirSync(path.join(temp.dir, 'custom'));
  writeFileSync(path.join(temp.dir, 'custom', 'theme.css'), 'body { color: red; }');
  const register = () => () => undefined;
  watchTheme({ dataDir: temp.dir, root: { register }, bus: recordingBus().bus });
  assert.equal(readFileSync(path.join(temp.dir, ROOT_THEME), 'utf8'), 'body { color: red; }');
  assert.equal(existsSync(path.join(temp.dir, 'custom', 'theme.css')), false);
  writeFileSync(path.join(temp.dir, 'custom', 'theme.css'), 'body { color: blue; }');
  watchTheme({ dataDir: temp.dir, root: { register }, bus: recordingBus().bus });
  assert.equal(readTheme(temp.dir), 'body { color: red; }');
});
