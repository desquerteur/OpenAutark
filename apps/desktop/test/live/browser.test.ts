// LIVE (opt-in): BrowserService with the installed Chrome/Edge (Playwright, own temporary
// profile, visible window) against a local test page (fixtures/browser-check.html, served from
// 127.0.0.1 by this test) – no real site, no person's profile, no mouse or keyboard input.
// Covers open + ARIA snapshot, fill by role/name, click, extract, screenshot and tabs, and reports
// how long each step took (test diagnostics – the numbers for the build log).
//   WORKFORCE_LIVE=1 node --test test/live/browser.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserService } from '../../src/runtime/browser/service.ts';
import { MemoryLogger } from '../../src/runtime/system/log.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'browser-check.html');

/** Runs `step` and returns its result with the milliseconds it took. */
async function timed<T>(step: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const result = await step();
  return [result, Math.round(performance.now() - started)];
}

test('browser: snapshot, fill, click, extract, screenshot on a local page', { skip: process.env.WORKFORCE_LIVE !== '1', timeout: 120_000 }, async (t) => {
  const page = await readFile(FIXTURE, 'utf8');
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-browser-'));
  const browser = new BrowserService({ paths: { data: dir, workspace: dir }, log: new MemoryLogger() });
  t.after(async () => {
    await browser.close().catch(() => undefined);
    server.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });

  // The first open launches the browser with a fresh profile: that is most of its time.
  const [opened, openMs] = await timed(() => browser.open('ag_live', { url }));
  assert.equal(opened.title, 'WF Browser Check');
  assert.match(opened.snapshot, /textbox "Name" \[ref=e\d+\]/, 'the ARIA snapshot carries refs');
  const [, fillMs] = await timed(() => browser.act('ag_live', { action: 'fill', target: { role: 'textbox', name: 'Name' }, value: 'Workforce' }));
  const [clicked, clickMs] = await timed(() => browser.act('ag_live', { action: 'click', target: { role: 'button', name: 'Send' } }));
  assert.equal(clicked.title, 'Submitted');
  assert.equal(clicked.changed, true, 'the action reports a visible change');
  const [extracted, extractMs] = await timed(() => browser.extract('ag_live', { css: '#out' }));
  assert.equal(extracted.text, 'Thanks Workforce');
  const [shot, shotMs] = await timed(() => browser.screenshot('ag_live'));
  assert.ok(shot.data.length > 1000 && shot.mime.startsWith('image/'));
  assert.equal((await browser.tabs('ag_live')).tabs.length, 1);
  t.diagnostic(`browser live: launch+open ${openMs} ms, fill ${fillMs} ms, click ${clickMs} ms, extract ${extractMs} ms, screenshot ${shotMs} ms (${shot.data.length} bytes, ${shot.mime})`);
});
