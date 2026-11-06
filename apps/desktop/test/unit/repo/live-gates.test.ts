// Live test gates (MP13 review, wave-7 carry-over): every test/live/*.test.ts runs only with
// WORKFORCE_LIVE=1, and every one that sends real mouse or keyboard input through the Windows
// computer helper (ComputerService click / move / drag / scroll / type / key, or the helper's
// input ops) also needs WORKFORCE_LIVE_COMPUTER=1 – `npm run test:live` runs them all, and
// WORKFORCE_LIVE=1 alone must never move the person's pointer.
// Owns: these assertions (a source scan). Never: runs a live test or touches input.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const liveDir = path.join(desktop, 'test', 'live');
const files = existsSync(liveDir) ? readdirSync(liveDir).filter((name) => name.endsWith('.test.ts')).sort() : [];
const source = (name: string) => readFileSync(path.join(liveDir, name), 'utf8');

/** Real input: a ComputerService input method or a helper input op. */
const REAL_INPUT = /\b(?:computer|helper)\s*\.\s*(?:click|move|drag|scroll|type|key)\s*\(|\bhelper\s*\.\s*call\s*(?:<[^>]*>)?\(\s*['"](?:click|move|drag|scroll|type|key)['"]/;
const INPUT_GATE = /process\.env\.WORKFORCE_LIVE_COMPUTER\s*===\s*'1'/;

test('the scan recognises real input', () => {
  assert.ok(REAL_INPUT.test("await computer.drag({ x1: 0, y1: 0, x2: 5, y2: 5 })"));
  assert.ok(REAL_INPUT.test("await helper.call('click', { x: 1, y: 2 })"));
  assert.ok(REAL_INPUT.test("helper.call<{ ok: boolean }>('type', { text: 'a' })"));
  assert.ok(!REAL_INPUT.test("await helper.call('act', { action: 'invoke' })"), 'UI Automation patterns are no input');
  assert.ok(!REAL_INPUT.test("await page.click('#ok')"), 'a browser page click is no OS input');
});

test('every live test is opt-in with WORKFORCE_LIVE=1', { skip: files.length === 0 && 'no test/live folder' }, () => {
  for (const name of files) assert.match(source(name), /process\.env\.WORKFORCE_LIVE\s*[!=]==\s*'1'/, name);
});

test('every live test with real mouse or keyboard input also needs WORKFORCE_LIVE_COMPUTER=1', { skip: files.length === 0 && 'no test/live folder' }, () => {
  const withInput = files.filter((name) => REAL_INPUT.test(source(name)));
  for (const known of ['computer-stop.test.ts', 'computer-use.test.ts']) {
    if (files.includes(known)) assert.ok(withInput.includes(known), `${known} sends real input`);
  }
  for (const name of withInput) assert.match(source(name), INPUT_GATE, `${name} moves the real pointer or types: gate it on WORKFORCE_LIVE_COMPUTER=1`);
});
