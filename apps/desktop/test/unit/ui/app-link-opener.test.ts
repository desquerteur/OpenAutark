// ui/open-link of a mini-app frame (ui/blocks/app-tools.ts linkOpener): only http(s) and mailto
// links up to 2048 characters, the human confirms every one (AppFrame passes lib/ui.tsx's
// confirm), one question at a time per frame, and nothing opens on "Cancel". app-tools.ts is plain
// .ts again (no lib/ui.tsx import), so the unit tests can load it.
// Owns: these assertions only. Never: a real window or dialog.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkOpener } from '../../../src/ui/blocks/app-tools.ts';

test('every link waits for the human; one question at a time; nothing opens on Cancel', async () => {
  const opened: string[] = [];
  (globalThis as { window?: unknown }).window = { open: (url: string) => { opened.push(url); } };
  const asked: Array<{ body?: string; answer: (yes: boolean) => void }> = [];
  const open = linkOpener((options) => new Promise<boolean>((answer) => { asked.push({ body: options.body, answer }); }));
  try {
    assert.deepEqual(await open('javascript:alert(1)'), { isError: true });
    assert.deepEqual(await open(`https://example.test/${'a'.repeat(2048)}`), { isError: true });
    assert.equal(asked.length, 0, 'refused without a question');

    const first = open('https://example.test/report?id=1');
    assert.deepEqual(await open('https://example.test/other'), { isError: true }, 'a second link while one is asked');
    asked[0].answer(true);
    assert.deepEqual(await first, {});
    assert.deepEqual(opened, ['https://example.test/report?id=1']);

    const second = open('mailto:team@example.test');
    asked[1].answer(false);
    assert.deepEqual(await second, { isError: true });
    assert.equal(opened.length, 1, 'Cancel opens nothing');
    assert.deepEqual(asked.map((entry) => entry.body), ['https://example.test/report?id=1', 'mailto:team@example.test']);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});
