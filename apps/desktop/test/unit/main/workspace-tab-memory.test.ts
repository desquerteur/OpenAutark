// The person's browser, main's two small memories (main/workspace-tab-memory.ts): the recently closed tabs, per space,
// and the zoom per site (Chrome's steps, kept per host name, 100 % forgets).
// Owns: these assertions. Never: Electron or a real profile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOSED_KEPT, ClosedTabs, SiteZoom, ZOOM_STEPS, zoomSite, zoomStep } from '../../../src/main/workspace-tab-memory.ts';
import type { TabFiles } from '../../../src/main/workspace-tabs.ts';

function memory(initial?: string): TabFiles & { text?: string } {
  const files = { text: initial, read: () => files.text, write: (_file: string, text: string) => { files.text = text; } };
  return files;
}

test('closed tabs: the last one of a space comes back first; no blank tab; the oldest go', () => {
  const closed = new ClosedTabs();
  closed.push({ url: 'about:blank', space: 'global' });
  closed.push({ url: '', space: 'global' });
  assert.equal(closed.pop('global'), undefined);
  closed.push({ url: 'https://a.test/', space: 'global' });
  closed.push({ url: 'https://b.test/', space: 'chat:c1' });
  closed.push({ url: 'https://c.test/', space: 'global' });
  assert.equal(closed.pop('chat:c1')?.url, 'https://b.test/', 'each space has its own');
  assert.equal(closed.pop('chat:c1'), undefined);
  assert.equal(closed.pop('global')?.url, 'https://c.test/');
  assert.equal(closed.pop('global')?.url, 'https://a.test/');
  for (let index = 0; index < CLOSED_KEPT + 2; index++) closed.push({ url: `https://s${index}.test/`, space: 'global' });
  const rest: string[] = [];
  for (let tab = closed.pop('global'); tab; tab = closed.pop('global')) rest.push(tab.url);
  assert.equal(rest.length, CLOSED_KEPT);
  assert.equal(rest.at(-1), 'https://s2.test/', 'the two oldest went');
});

test("zoom: Chrome's steps in and out, clamped, 0 back to 100; kept per host name, 100 forgets", () => {
  assert.equal(zoomStep(100, 1), 110);
  assert.equal(zoomStep(100, -1), 90);
  assert.equal(zoomStep(110, 1), 125);
  assert.equal(zoomStep(500, 1), 500);
  assert.equal(zoomStep(25, -1), 25);
  assert.equal(zoomStep(133, 0), 100);
  assert.equal(zoomStep(105, -1), 100, 'from between two steps to the next one');
  assert.equal(zoomSite('https://docs.example.com:8443/a?b'), 'docs.example.com');
  assert.equal(zoomSite('file:///x'), undefined);
  const files = memory();
  const zoom = new SiteZoom({ file: 'z.json', files });
  zoom.set('https://docs.example.com/a', 125);
  assert.equal(zoom.percent('https://docs.example.com/other/page'), 125, 'every page of the site');
  assert.equal(zoom.percent('http://docs.example.com/'), 125, 'the host, as Chrome keeps it');
  assert.equal(zoom.percent('https://example.com/'), 100);
  zoom.set('https://docs.example.com/', 133);
  assert.equal(zoom.percent('https://docs.example.com/'), 125, 'only Chrome steps');
  const saved = memory(files.text);
  const again = new SiteZoom({ file: 'z.json', files: saved });
  assert.equal(again.percent('https://docs.example.com/'), 125, 'read back');
  again.set('https://docs.example.com/', 100);
  assert.deepEqual(JSON.parse(saved.text!).sites, {}, 'back to 100 %: the site has no entry');
  const foreign = new SiteZoom({ file: 'z.json', files: memory(JSON.stringify({ sites: { 'a.test': 150, 'b.test': 7, 'c.test': 100 } })) });
  assert.deepEqual(['a.test', 'b.test', 'c.test'].map((host) => foreign.percent(`https://${host}/`)), [150, 100, 100], 'only Chrome steps other than 100 are read');
  assert.ok(ZOOM_STEPS.includes(100));
});
