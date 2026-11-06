// ComputerService with a fake helper and host: human priority, coordinate validation and
// mapping, screenshot downscale on hosts, act-and-verify, preview (local and linked PC), and
// (B-044) input on the Workforce window only after the window's guarded-control check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComputerService, unpackedPath } from '../../../src/runtime/computer/service.ts';
import { windowLine } from '../../../src/runtime/computer/tools.ts';
import type { HelperClient } from '../../../src/runtime/computer/helper.ts';
import type { HelperOp } from '../../../src/runtime/computer/protocol.ts';
import type { Host } from '../../../src/runtime/host.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { decodePng, encodePng, pngSize } from '../../../src/runtime/computer/png.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

class FakeHelper implements HelperClient {
  calls: Array<{ op: HelperOp; args: Record<string, unknown> }> = [];
  answers: Partial<Record<HelperOp, (args: Record<string, unknown>) => unknown>> = {};
  isRunning = true;
  async call<T>(op: HelperOp, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ op, args });
    const answer = this.answers[op];
    return (answer ? answer(args) : { done: true }) as T;
  }
  running(): boolean { return this.isRunning; }
  async dispose(): Promise<void> { this.isRunning = false; }
  ops(): string[] { return this.calls.map((call) => call.op); }
}

function host(patch: Partial<Host> = {}): Host & { idle: number } {
  const value: Host & { idle: number } = {
    kind: 'electron', idle: 60,
    encrypt: async () => new Uint8Array(), decrypt: async () => '', notify: async () => false,
    openExternal: async () => {}, openPath: async () => {}, onPower: () => () => {},
    keepAwake: () => () => {}, app: { version: '1.0.0', packaged: false, resourcesDir: '/r', dataDir: '/d', executable: 'node' },
    async idleSeconds(): Promise<number> { return value.idle; },
    ...patch,
  };
  return value;
}

function service(options: { platform?: NodeJS.Platform; host?: Host; services?: () => RuntimeServices; now?: () => number } = {}) {
  const helper = new FakeHelper();
  const h = (options.host ?? host()) as Host & { idle: number };
  const computer = new ComputerService({
    host: h, supervisor: { spawn: () => { throw new Error('no processes in tests'); } }, resourcesDir: '/r', log: new MemoryLogger(),
    helper, platform: options.platform ?? 'win32', services: options.services, now: options.now,
  });
  return { computer, helper, host: h };
}

test('human priority: recent input that is not ours pauses every input action', async () => {
  let now = 100_000;
  const { computer, helper, host: h } = service({ now: () => now });
  h.idle = 0;
  const instant = { motion: 'instant' as const }; // the old one-shot ops (glide and human paths: motion.test.ts)
  await assert.rejects(computer.click({ x: 10, y: 10, ...instant }), (error: unknown) => {
    assert.ok(error instanceof WorkforceError);
    assert.equal(error.code, 'conflict');
    assert.match(error.message, /^The person is using the computer – retrying later/);
    assert.equal(error.retryAfterMs, 5000);
    return true;
  });
  await assert.rejects(computer.type({ text: 'hello' }), /using the computer/);
  await assert.rejects(computer.key({ combo: 'enter' }), /using the computer/);
  assert.deepEqual(helper.ops(), []); // nothing was injected

  h.idle = 30; // the person stopped
  await computer.click({ x: 10, y: 10, ...instant });
  assert.deepEqual(helper.ops(), ['click']);

  // Right after our own click the host idle time is 0 again: the helper's precise tick
  // counts tell our input from the person's.
  now += 400;
  h.idle = 0;
  helper.answers.presence = () => ({ idleMs: 300, injectedAgoMs: 320 });
  await computer.click({ x: 20, y: 20, ...instant });
  assert.deepEqual(helper.ops(), ['click', 'presence', 'click']);
  helper.answers.presence = () => ({ idleMs: 50, injectedAgoMs: 900 });
  await assert.rejects(computer.drag({ x1: 0, y1: 0, x2: 5, y2: 5 }), /using the computer/);

  // A headless Windows runtime has no idle source of its own: the helper decides alone.
  const headless = service({ host: host({ kind: 'node', async idleSeconds() { return 3600; } }) });
  headless.helper.answers.presence = () => ({ idleMs: 400, injectedAgoMs: null });
  await assert.rejects(headless.computer.click({ x: 1, y: 1, ...instant }), /using the computer/);
  headless.helper.answers.presence = () => ({ idleMs: 9000, injectedAgoMs: null });
  await headless.computer.click({ x: 1, y: 1, ...instant });
  assert.deepEqual(headless.helper.ops(), ['presence', 'presence', 'click']);
});

test('coordinates are validated with Number.isFinite before anything reaches the helper', async () => {
  const { computer, helper } = service();
  await assert.rejects(computer.click({ x: Number.NaN, y: 4 }), /x must be a finite number/);
  await assert.rejects(computer.drag({ x1: 0, y1: 0, x2: Number.POSITIVE_INFINITY, y2: 1 }), /x2 must be a finite number/);
  await assert.rejects(computer.scroll({ x: 5, dy: 1 }), /both x and y/);
  await assert.rejects(computer.scroll({ dy: 0 }), /at least one step/);
  assert.deepEqual(helper.ops(), []);
  await computer.drag({ x1: 0, y1: 0, x2: 300, y2: 0, motion: 'instant' }); // zeros are real coordinates
  const drag = helper.calls[0];
  assert.equal(drag.op, 'path');
  assert.deepEqual([drag.args.end, drag.args.button, drag.args.steps], ['drag', 'left', [0, 0, 0]], 'an instant drag jumps to its start');
  assert.deepEqual((drag.args.drag as number[]).slice(-3, -1), [300, 0], 'and travels to its end held down');
});

test('screenshots report geometry; screenshot-pixel clicks are mapped to the screen', async () => {
  const { computer, helper } = service();
  helper.answers.screenshot = () => ({ data: Buffer.from('jpeg-bytes').toString('base64'), mime: 'image/jpeg', width: 1600, height: 900, x: 1920, y: 0, srcWidth: 3840, srcHeight: 2160 });
  const shot = await computer.screenshot({ display: 1, agentId: 'ag_1' });
  assert.equal(shot.scale, 2.4);
  assert.deepEqual(shot.origin, { x: 1920, y: 0 });
  assert.equal(Buffer.from(shot.data).toString(), 'jpeg-bytes');
  assert.deepEqual(helper.calls[0].args, { screen: 1, hwnd: undefined, region: undefined, maxEdge: 1600, quality: 70, format: 'jpeg' });
  await computer.click({ x: 800, y: 450, coords: 'screenshot', agentId: 'ag_1', motion: 'instant' });
  assert.deepEqual(helper.calls[1], { op: 'click', args: { x: 1920 + 1921, y: 1081, button: 'left', count: 1 } });
  await assert.rejects(computer.click({ x: 1, y: 1, coords: 'screenshot', agentId: 'ag_other' }), /No screenshot yet/);
});

test('macOS/Linux: honest "unavailable" for control, screenshots through the host (downscaled PNG)', async () => {
  const wide = { width: 3200, height: 1000, channels: 3 as const, pixels: new Uint8Array(3200 * 1000 * 3).fill(128) };
  const captured: unknown[] = [];
  const h = host({ capture: { screenshot: async (target, format) => { captured.push({ target, format }); return { data: encodePng(wide), width: 3200, height: 1000, mime: 'image/png' }; }, displays: async () => [] } });
  const { computer, helper } = service({ platform: 'darwin', host: h });
  await assert.rejects(computer.click({ x: 1, y: 1 }), (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable' && /only available on Windows/.test(error.message));
  await assert.rejects(computer.windows(), /only available on Windows/);
  await assert.rejects(computer.screenshot({ window: 5 }), /only available on Windows/);
  const shot = await computer.screenshot({});
  assert.deepEqual(captured, [{ target: { display: 0 }, format: 'png' }]);
  assert.deepEqual(pngSize(shot.data), { width: 1600, height: 500 });
  assert.equal(shot.scale, 2);
  assert.equal(shot.source, 'host');
  assert.equal(decodePng(shot.data)!.pixels[0], 128);
  assert.deepEqual(helper.ops(), []);
  const headless = service({ platform: 'linux', host: host() });
  await assert.rejects(headless.computer.screenshot({}), /no screen to capture/);
});

test('element actions pass the observed identity as a hard precondition and verify expectations', async () => {
  const { computer, helper } = service();
  helper.answers.tree = () => ({
    hwnd: 77, title: 'Settings', truncated: false,
    nodes: [
      { d: 0, p: -1, rid: '1', role: 'window', name: 'Settings' },
      { d: 1, p: 0, rid: '1.2', role: 'edit', name: 'Name', value: 'old', patterns: ['value'] },
    ],
  });
  const tree = await computer.uiTree({ window: 77 });
  assert.match(tree.text, /edit "Name" \[ref=e2\] = "old"/);
  helper.answers.act = () => ({ exists: true, element: { rid: '1.2', role: 'edit', name: 'Name', value: 'new' }, foreground: { title: 'Settings' } });
  const ok = await computer.act({ ref: 'e2', action: 'set_value', value: 'new', expect: { value: 'new' } });
  const actArgs = helper.calls.find((call) => call.op === 'act')!.args;
  assert.equal(actArgs.hwnd, 77);
  assert.equal(actArgs.rid, '1.2');
  assert.equal(actArgs.expectName, 'Name');
  assert.equal(actArgs.expectRole, 'edit');
  assert.equal(ok.verified, true);
  assert.match(ok.after ?? '', /= "new"/);
  const bad = await computer.act({ ref: 'e2', action: 'set_value', value: 'new', expect: { value: 'other' } });
  assert.equal(bad.verified, false);
  assert.match(bad.checks.join('\n'), /FAILED: value is "other"/);
  await assert.rejects(computer.act({ ref: 'e99', action: 'invoke' }), /Unknown ref "e99"/);
  // set_value uses a pattern (no pointer, no focus): no human-presence gate needed.
  assert.equal(helper.ops().includes('presence'), false);
});

test('preview: this PC as a data URL, a linked PC through DeviceService', async () => {
  const deviceCalls: unknown[] = [];
  const services = () => ({
    devices: {
      self: () => ({ id: 'dev_self' }),
      call: async (deviceId: string, method: string, params: unknown) => { deviceCalls.push({ deviceId, method, params }); return { dataUrl: 'data:image/jpeg;base64,AAAA', width: 10, height: 5, at: 1 }; },
    },
  }) as unknown as RuntimeServices;
  const { computer, helper } = service({ services });
  helper.answers.screenshot = () => ({ data: Buffer.from('x').toString('base64'), mime: 'image/jpeg', width: 4, height: 2, x: 0, y: 0, srcWidth: 4 });
  const local = await computer.preview({});
  assert.equal(local.dataUrl, `data:image/jpeg;base64,${Buffer.from('x').toString('base64')}`);
  assert.equal(helper.calls[0].args.maxEdge, 1280);
  const remote = await computer.preview({ deviceId: 'dev_other', display: 1 });
  assert.deepEqual(deviceCalls, [{ deviceId: 'dev_other', method: 'computer.preview', params: { display: 1 } }]);
  assert.equal(remote.width, 10);
  const self = await computer.preview({ deviceId: 'dev_self' });
  assert.equal(self.width, 4);
});

test('the window list marks the Workforce app\'s own window', async () => {
  const { computer, helper } = service();
  helper.answers.windows = () => [{ hwnd: 5, title: 'Workforce', process: 'electron', pid: 1, foreground: true, app: true }, { hwnd: 6, title: 'Notes', process: 'notepad', pid: 2 }];
  const list = await computer.windows();
  assert.deepEqual(list.map((window) => [window.hwnd, window.app]), [[5, true], [6, false]]);
  assert.match(windowLine(list[0]), /\[foreground\] \[Autark – this app\]$/);
  assert.doesNotMatch(windowLine(list[1]), /Autark|off limits/);
});

test('the helper script is read from app.asar.unpacked in packaged builds', () => {
  assert.equal(unpackedPath('C:\\Program Files\\Workforce\\resources\\app.asar\\resources\\computer\\windows-helper.ps1'), 'C:\\Program Files\\Workforce\\resources\\app.asar.unpacked\\resources\\computer\\windows-helper.ps1');
  assert.equal(unpackedPath('/opt/w/resources/app.asar/resources/x.ps1'), '/opt/w/resources/app.asar.unpacked/resources/x.ps1');
  assert.equal(unpackedPath('/dev/resources/x.ps1'), '/dev/resources/x.ps1');
});
