// Settings search (ui/settings/sections.ts searchSections): the words of rows that are still on a page find it – the
// Devices page's "Accept connection requests" row by "connection" (B-078 review).
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchSections } from '../../../src/ui/settings/sections.ts';

test('"connection" and "connection requests" find the Devices page', () => {
  for (const text of ['connection', 'connection requests', 'accept connection requests', 'meeting server']) {
    assert.ok(searchSections(text).some((section) => section.id === 'devices'), text);
  }
});
