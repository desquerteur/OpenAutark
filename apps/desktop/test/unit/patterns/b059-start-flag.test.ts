// B-059 #87: the first run picks no team since B-047 D7, so no built-in pattern carries the old `start: true` preselect
// flag any more (the `start` search tag of the Starter team stays).
// Owns: nothing in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { RESOURCES } from '../store/helpers.ts';

test('B-059 #87: no built-in pattern has a start flag; the Starter team keeps its start tag', () => {
  const dir = path.join(RESOURCES, 'patterns');
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.md'))) {
    assert.doesNotMatch(readFileSync(path.join(dir, name), 'utf8'), /^start:/m, name);
  }
  assert.match(readFileSync(path.join(dir, 'starter.md'), 'utf8'), /^tags: \[start,/m);
});
