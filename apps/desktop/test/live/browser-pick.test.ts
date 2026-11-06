// LIVE (opt-in): the MP10 pick with the installed Chrome/Edge (Playwright, own temporary profile,
// window off-screen) against a local test page served from 127.0.0.1 by this test – no real
// site, no person's profile, no mouse or keyboard input (a pick only reads the page).
// Covers: DOM.getNodeForLocation at a frame point finds the element and its parents with role,
// accessible name, CSS path and its real rectangle, also on a scrolled page (the hit test takes
// document coordinates: the point plus the scroll position); the page's own scripts neither
// change nor see what the isolated world reads (they replaced getBoundingClientRect and getAttribute).
//   WORKFORCE_LIVE=1 node --test test/live/browser-pick.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserService } from '../../src/runtime/browser/service.ts';
import { BrowserView } from '../../src/runtime/browser/view.ts';
import type { RuntimeServices } from '../../src/runtime/contracts.ts';
import type { BrowserFrame } from '../../src/shared/model/browser.ts';
import { MemoryLogger } from '../../src/runtime/system/log.ts';

const PAGE = `<!doctype html><title>WF Pick Check</title>
<style>
  body { margin: 0; height: 4000px; }
  #buy { position: absolute; left: 100px; top: 120px; width: 200px; height: 40px; padding: 0 8px; text-align: left; }
  #buy b { position: absolute; left: 150px; top: 0; width: 50px; height: 40px; }
  #far { position: absolute; left: 100px; top: 2000px; width: 200px; height: 40px; }
</style>
<main><button id="buy" aria-label="Buy now">Buy <b>now</b></button><div id="far">Far below</div></main>
<script>
  // A page that tries to steer or notice the reading: neither may work from the isolated world.
  Element.prototype.getBoundingClientRect = function () { document.title = 'touched'; return { left: 0, top: 0, width: 0, height: 0 }; };
  Element.prototype.getAttribute = function () { document.title = 'touched'; return 'fake'; };
</script>`;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('browser pick: the element under a point and its parents, read in an isolated world', { skip: process.env.WORKFORCE_LIVE !== '1', timeout: 120_000 }, async (t) => {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-browser-pick-'));
  const browser = new BrowserService({ paths: { data: dir, workspace: dir }, log: new MemoryLogger() });
  const frames: BrowserFrame[] = [];
  const services = {
    log: new MemoryLogger(), secrets: { redact: (text: string) => text },
    bus: { emit: (event: string, data: unknown) => { if (event === 'browser.frame') frames.push(data as BrowserFrame); } },
  } as unknown as RuntimeServices;
  const view = new BrowserView({ browser, services: () => services });
  t.after(async () => {
    await browser.close().catch(() => undefined);
    server.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });

  await browser.open('ag_live', { url: `http://127.0.0.1:${port}/` });
  const release = view.watch('ag_live');
  for (let i = 0; i < 50 && !frames.length; i++) await wait(100);
  assert.ok(frames.length > 0, 'a frame arrives once watched');
  const { width, height, tab } = frames[0];
  const at = (x: number, y: number) => ({ x, y, width, height }); // CSS px: the frame is the viewport at page scale 1

  const onText = await view.pick('ag_live', tab, at(120, 140));
  assert.equal(onText.host, '127.0.0.1');
  assert.deepEqual(onText.view, { width, height });
  const [button, main] = onText.chain;
  assert.deepEqual({ tag: button.tag, role: button.role, name: button.name, cssPath: button.cssPath }, { tag: 'button', role: 'button', name: 'Buy now', cssPath: 'button#buy' });
  assert.ok(Math.abs(button.rect.x - 100) <= 1 && Math.abs(button.rect.y - 120) <= 1 && Math.abs(button.rect.width - 200) <= 1, JSON.stringify(button.rect));
  assert.ok(Math.abs(button.box.x - 100 / width) < 0.01, JSON.stringify(button.box));
  assert.equal(main.tag, 'main');
  assert.equal(onText.chain.at(-1)?.tag, 'body', 'the chain ends at body');

  const onBold = await view.pick('ag_live', tab, at(270, 140));
  assert.deepEqual(onBold.chain.slice(0, 2).map((entry) => entry.tag), ['b', 'button']);

  // Scrolled by 1800 px: #far (document y 2000) is drawn at viewport y 200.
  const page = browser.viewOf('ag_live')?.active;
  await (page as unknown as { evaluate(script: string): Promise<unknown> }).evaluate('window.scrollTo(0, 1800)');
  const below = await view.pick('ag_live', tab, at(150, 220));
  assert.equal(below.chain[0]?.cssPath, 'div#far', JSON.stringify(below.chain[0]));
  assert.ok(Math.abs(below.chain[0].rect.y - 200) <= 1 && Math.abs(below.chain[0].box.y - 200 / height) < 0.01, JSON.stringify(below.chain[0]));

  assert.equal(await page?.title(), 'WF Pick Check', 'the page\'s replaced functions were never called');
  assert.equal(browser.takeovers.active('ag_live'), false, 'picking is no takeover');
  release();
  t.diagnostic(`browser pick: ${onText.chain.length} elements at the point, frame ${width}×${height}`);
});
