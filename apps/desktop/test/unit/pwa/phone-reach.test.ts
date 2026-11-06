// B-075 (live 04.11.2026): the owner's QR codes pointed at http://localhost:47811 – no phone can open that. Now the
// https address `tailscale serve` forwards to the app's port comes first (read from `tailscale serve status --json`,
// a fake here), a link is refused while only this PC's loopback answers, phone access turned on without a choice
// takes the same network then, and the 6-digit code beside the QR (an installed iPhone app has its own storage) is
// the same one-time exchange as #pair=, with a wrong-code limit per code (a right code is full owner access).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SettingsService } from '../../../src/runtime/contracts.ts';
import { PushService } from '../../../src/runtime/pwa/push.ts';
import { MAX_WRONG_CODES } from '../../../src/runtime/pwa/pair-code.ts';
import { PwaService, SERVE_CACHE_MS, UNREACHABLE } from '../../../src/runtime/pwa/service.ts';
import { LINK_TTL_MS } from '../../../src/runtime/pwa/tokens.ts';
import { reachableUrls, serveUrls } from '../../../src/runtime/pwa/urls.ts';
import { ManualClock, memoryDb, recordingBus, silentLog } from '../devices/fakes.ts';

type Bind = 'localhost' | 'lan' | 'tailscale';

/** The JSON of `tailscale serve status --json` (shape read on the owner's PC, tailscale 1.104). */
function status(web: Record<string, string>, https: number[] = [443, 8443]): string {
  return JSON.stringify({
    TCP: Object.fromEntries(https.map((port) => [String(port), { HTTPS: true }])),
    Web: Object.fromEntries(Object.entries(web).map(([hostPort, proxy]) => [hostPort, { Handlers: { '/': { Proxy: proxy } } }])),
  });
}
const OWN = status({ 'pc.tail1.ts.net:443': 'http://127.0.0.1:5173', 'pc.tail1.ts.net:8443': 'http://127.0.0.1:47811' });
const LAN = () => ({ eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false } as never] });

function setup(options: { bind?: Bind; serve?: string; interfaces?: () => Record<string, never[]> } = {}) {
  const settings = { pwa: { enabled: true, bind: options.bind ?? 'localhost' as Bind } };
  const clock = new ManualClock();
  let reads = 0;
  const push = new PushService({ db: memoryDb(), clock, log: silentLog, vapid: async () => { throw new Error('not in these tests'); } });
  const pwa = new PwaService({
    db: memoryDb(), clock, bus: recordingBus().bus, log: silentLog, push, port: () => 47811, qr: async (text) => `qr:${text}`,
    settings: {
      get: () => settings,
      update: (patch: { pwa?: Partial<typeof settings.pwa> }) => { Object.assign(settings.pwa, patch.pwa ?? {}); return settings; },
    } as unknown as SettingsService,
    interfaces: options.interfaces ?? (() => ({})),
    serveStatus: async () => { reads++; return options.serve; },
  });
  return { pwa, settings, clock, reads: () => reads };
}

const rejectsWith = (promise: Promise<unknown> | (() => unknown), code: string, pattern?: RegExp) =>
  assert.rejects(async () => (typeof promise === 'function' ? promise() : promise), (error: { code?: string; message?: string }) => error.code === code && (!pattern || pattern.test(error.message ?? '')));

test('serveUrls: only https handlers of "/" that forward to our port on this PC, 443 without a port', () => {
  assert.deepEqual(serveUrls(OWN, 47811), ['https://pc.tail1.ts.net:8443']);
  assert.deepEqual(serveUrls(status({ 'PC.tail1.ts.net:443': '47811' }), 47811), ['https://pc.tail1.ts.net']);
  assert.deepEqual(serveUrls(status({ 'pc.tail1.ts.net:443': 'localhost:47811' }), 47811), ['https://pc.tail1.ts.net']);
  assert.deepEqual(serveUrls(status({ 'pc.tail1.ts.net:80': 'http://127.0.0.1:47811' }, [443]), 47811), [], 'a plain-http serve port is no https address');
  assert.deepEqual(serveUrls(status({ 'pc.tail1.ts.net:443': 'http://192.168.1.5:47811' }), 47811), [], 'another machine');
  assert.deepEqual(serveUrls(status({ 'pc.tail1.ts.net:443': 'http://127.0.0.1:5173' }), 47811), [], 'the owner\'s own / mapping to another port');
  for (const bad of [undefined, '', 'not json', '[]', '{"Web":3}', '{"Web":{"x:443":{"Handlers":{"/":{}}}}}']) assert.deepEqual(serveUrls(bad, 47811), [], String(bad));
});

test('urls(): the tailscale https address first, then localhost, then the LAN; read once per SERVE_CACHE_MS', async () => {
  const h = setup({ bind: 'lan', serve: OWN, interfaces: LAN as never });
  assert.deepEqual(await h.pwa.freshUrls(), ['https://pc.tail1.ts.net:8443', 'http://localhost:47811', 'http://192.168.1.20:47811']);
  const state = await h.pwa.state();
  assert.equal(state.secure, true, 'https is the first address');
  assert.equal(h.reads(), 1, 'cached');
  h.clock.advance(SERVE_CACHE_MS);
  await h.pwa.state();
  assert.equal(h.reads(), 2, 'read again after the cache time');
  assert.deepEqual(reachableUrls({ port: 47811, bind: 'localhost' }), ['http://localhost:47811'], 'unchanged without tailscale');
});

test('urls() without waiting (a person\'s invite): an old read starts a new one, so the next call has the https address', async () => {
  const h = setup({ serve: OWN });
  assert.deepEqual(h.pwa.urls(), ['http://localhost:47811'], 'nothing read yet');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.pwa.urls(), ['https://pc.tail1.ts.net:8443', 'http://localhost:47811']);
  assert.equal(h.reads(), 1, 'one read, then cached');
  h.clock.advance(SERVE_CACHE_MS);
  h.pwa.urls();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.reads(), 2, 'read again once the cache time passed');
});

test('a link is never a localhost-only QR: refused while phones cannot reach this PC, with the way out', async () => {
  const none = setup();
  await rejectsWith(none.pwa.link(), 'conflict', /choose .The same network. or ask the AI to set up Tailscale/);
  assert.equal(UNREACHABLE.includes('localhost'), false);
  const otherPort = setup({ serve: status({ 'pc.tail1.ts.net:443': 'http://127.0.0.1:5173' }) });
  await rejectsWith(otherPort.pwa.link(), 'conflict', /can't reach this PC yet/);

  const served = setup({ serve: OWN });
  const link = await served.pwa.link();
  assert.match(link.url, /^https:\/\/pc\.tail1\.ts\.net:8443\/#pair=[\w-]{40,}$/);
  assert.equal(link.qrDataUrl, `qr:${link.url}`);
  assert.match(link.code, /^\d{6}$/);
  const lan = setup({ bind: 'lan', interfaces: LAN as never });
  assert.match((await lan.pwa.link()).url, /^http:\/\/192\.168\.1\.20:47811\/#pair=/);
});

test('phone access turned on without a choice: the same network while only the loopback answers, otherwise the bind stays', async () => {
  const alone = setup();
  alone.settings.pwa.enabled = false;
  await alone.pwa.enable({ enabled: true });
  assert.deepEqual(alone.settings.pwa, { enabled: true, bind: 'lan' });

  const served = setup({ serve: OWN });
  served.settings.pwa.enabled = false;
  await served.pwa.enable({ enabled: true });
  assert.deepEqual(served.settings.pwa, { enabled: true, bind: 'localhost' }, 'tailscale serve forwards to the loopback');

  const chosen = setup();
  await chosen.pwa.enable({ enabled: true, bind: 'localhost' });
  assert.equal(chosen.settings.pwa.bind, 'localhost', 'an explicit choice wins');
  await chosen.pwa.enable({ enabled: false });
  assert.deepEqual(chosen.settings.pwa, { enabled: true, bind: 'localhost' }, 'D5: no switch – false turns nothing off and keeps the bind');
  const tailnet = setup({ bind: 'tailscale' });
  await tailnet.pwa.enable({ enabled: true });
  assert.equal(tailnet.settings.pwa.bind, 'tailscale', 'only "This PC only" moves');
});

test('the 6-digit code: the same one-time exchange as #pair= (valid, used, the link burned with it, spaces allowed)', async () => {
  const h = setup({ serve: OWN });
  const first = await h.pwa.link({ name: 'iPhone app' });
  const paired = h.pwa.exchange(`${first.code.slice(0, 3)} ${first.code.slice(3)}`, { name: 'iPhone · Safari' });
  assert.equal(h.pwa.authenticate(paired.token)?.kind, 'device');
  assert.equal((await h.pwa.state()).devices.find((device) => device.id === paired.deviceId)?.name, 'iPhone app', 'the link\'s name');
  assert.throws(() => h.pwa.exchange(first.code), (error: { code?: string; message?: string }) => error.code === 'forbidden' && /wrong or has expired/.test(error.message ?? ''), 'one use');
  const secret = /#pair=([^&]+)/.exec(first.url)![1];
  assert.throws(() => h.pwa.exchange(secret), /expired or was already used/, 'the code used the link up');

  const second = await h.pwa.link();
  assert.ok(h.pwa.exchange(/#pair=([^&]+)/.exec(second.url)![1]).token);
  assert.throws(() => h.pwa.exchange(second.code), /already used/, 'the QR used the code\'s link up');
});

test('the code: expired after the link\'s 10 minutes, wrong codes refused (B-078: no switch in between)', async () => {
  const h = setup({ serve: OWN });
  const link = await h.pwa.link();
  const wrong = link.code === '000000' ? '000001' : '000000';
  assert.throws(() => h.pwa.exchange(wrong), /wrong or has expired/);
  h.clock.advance(LINK_TTL_MS);
  assert.throws(() => h.pwa.exchange(link.code), /wrong or has expired/, 'expired with its link');
});

/** MAX_WRONG_CODES six-digit codes none of the given codes is. */
const wrongCodes = (...open: string[]) => Array.from({ length: MAX_WRONG_CODES + open.length }, (_, idx) => String(idx).padStart(6, '9')).filter((code) => !open.includes(code)).slice(0, MAX_WRONG_CODES);
const limited = (error: { code?: string; message?: string }) => error.code === 'rate_limited' && /again for a new one/.test(error.message ?? '');

test('wrong codes: the open codes face MAX_WRONG_CODES together, the last drops them all (rate_limited) – the QR still works, a new code too', async () => {
  const h = setup({ serve: OWN });
  const first = await h.pwa.link();
  const second = await h.pwa.link();
  const wrongs = wrongCodes(first.code, second.code);
  for (const code of wrongs.slice(0, -1)) assert.throws(() => h.pwa.exchange(code), /wrong or has expired/);
  h.clock.advance(5 * 60_000);
  assert.throws(() => h.pwa.exchange(wrongs.at(-1)!), limited, 'no time window gives a code more guesses');
  assert.throws(() => h.pwa.exchange(first.code), /wrong or has expired/, 'a code that was valid is dropped');
  assert.throws(() => h.pwa.exchange(second.code), /wrong or has expired/, 'every open code is dropped');
  assert.ok(h.pwa.exchange(/#pair=([^&]+)/.exec(first.url)![1]).token, 'the QR link is never limited');

  const next = await h.pwa.link();
  assert.ok(h.pwa.exchange(next.code).token, 'a new code works right away');
});

test('wrong codes count only against open codes: with none open (used or expired) counting starts again', async () => {
  const h = setup({ serve: OWN });
  const used = await h.pwa.link();
  const wrongs = wrongCodes(used.code);
  for (const code of wrongs.slice(0, -1)) assert.throws(() => h.pwa.exchange(code), /wrong or has expired/);
  assert.ok(h.pwa.exchange(used.code).token);
  for (const code of wrongs) assert.throws(() => h.pwa.exchange(code), /wrong or has expired/, 'nothing open to guess');

  const expired = await h.pwa.link();
  for (const code of wrongCodes(expired.code).slice(0, -1)) assert.throws(() => h.pwa.exchange(code), /wrong or has expired/);
  h.clock.advance(LINK_TTL_MS);
  const fresh = await h.pwa.link();
  for (const code of wrongCodes(fresh.code).slice(0, -1)) assert.throws(() => h.pwa.exchange(code), /wrong or has expired/);
  assert.ok(h.pwa.exchange(fresh.code).token, 'the new code has its own guesses');
});
