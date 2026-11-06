// LIVE (opt-in): the MP8 live view with the installed Chrome/Edge (Playwright, own temporary
// profile, window off-screen) against the local test page (fixtures/browser-check.html, served
// from 127.0.0.1 by this test) – no real site, no person's profile, no mouse or keyboard input.
// Covers: real screencast frames (JPEG, ≤ 1280 px wide) only while watched, a stored secret typed
// into a plain text field yields no frame until the tab leaves the host (127.0.0.1 → localhost),
// then frames come again; reports frame sizes and timings (test diagnostics).
//   WORKFORCE_LIVE=1 node --test test/live/browser-view.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserService } from '../../src/runtime/browser/service.ts';
import { BrowserView } from '../../src/runtime/browser/view.ts';
import type { RuntimeServices } from '../../src/runtime/contracts.ts';
import type { BrowserFrame, BrowserViewState } from '../../src/shared/model/browser.ts';
import { MemoryLogger } from '../../src/runtime/system/log.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'browser-check.html');
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('browser live view: real frames while watched, none while a secret is filled in', { skip: process.env.WORKFORCE_LIVE !== '1', timeout: 120_000 }, async (t) => {
  const html = await readFile(FIXTURE, 'utf8');
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-browser-view-'));
  const browser = new BrowserService({ paths: { data: dir, workspace: dir }, log: new MemoryLogger() });
  const frames: BrowserFrame[] = [];
  const states: BrowserViewState[] = [];
  const services = {
    log: new MemoryLogger(), secrets: { redact: (text: string) => text },
    bus: { emit: (event: string, data: unknown) => { if (event === 'browser.frame') frames.push(data as BrowserFrame); if (event === 'browser.view') states.push(data as BrowserViewState); } },
  } as unknown as RuntimeServices;
  const view = new BrowserView({ browser, services: () => services });
  t.after(async () => {
    await browser.close().catch(() => undefined);
    server.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });

  await browser.open('ag_live', { url: `http://127.0.0.1:${port}/` });
  await wait(800);
  assert.equal(frames.length, 0, 'no frames while nobody watches');
  const release = view.watch('ag_live');
  const started = performance.now();
  for (let i = 0; i < 50 && !frames.length; i++) await wait(100);
  const firstMs = Math.round(performance.now() - started);
  assert.ok(frames.length > 0, 'a frame arrives once watched');
  assert.ok(frames[0].data.startsWith('/9j/'), 'JPEG');
  const bytes = Buffer.from(frames[0].data, 'base64');
  const width = bytes.readUInt16BE(bytes.indexOf(Buffer.from([0xff, 0xc0])) + 7);
  assert.ok(width > 0 && width <= 1280, `frame width ${width}`);

  await browser.act('ag_live', { action: 'type', target: { role: 'textbox', name: 'Name' }, secret: async () => 'live-secret-value' });
  const during = frames.length;
  await browser.act('ag_live', { action: 'click', target: { role: 'button', name: 'Send' } });
  await wait(1200);
  assert.equal(frames.length, during, 'no frame while the tab holds the typed secret');
  assert.equal(states.at(-1)?.hidden?.host, '127.0.0.1');

  await browser.open('ag_live', { url: `http://localhost:${port}/` });
  for (let i = 0; i < 50 && frames.length === during; i++) await wait(100);
  assert.ok(frames.length > during, 'frames again once the tab left the host');
  assert.equal(states.at(-1)?.hidden, undefined);
  release();
  t.diagnostic(`browser live view: first frame after ${firstMs} ms, ${bytes.length} bytes, ${width} px wide, ${frames.length} frames`);
});
