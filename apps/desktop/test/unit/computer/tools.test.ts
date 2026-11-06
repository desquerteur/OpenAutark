// Device tool definitions (names, categories, remote/requires flags, external effects in
// describe) and the peer handlers that execute remote calls on a linked PC.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceTools, registerDeviceHandlers } from '../../../src/runtime/devices/tools.ts';
import type { ComputerService } from '../../../src/runtime/computer/service.ts';
import type { BrowserService } from '../../../src/runtime/browser/service.ts';
import type { AdbPhone } from '../../../src/runtime/phone/adb.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolDef } from '../../../src/runtime/tools/types.ts';
import type { PeerHandler } from '../../../src/runtime/devices/rpc-peer.ts';
import { agent } from '../chat/harness.ts';

const tools = deviceTools({ computer: {} as ComputerService, browser: {} as BrowserService, phone: {} as AdbPhone });
const byName = new Map(tools.map((tool) => [tool.name, tool]));
const ctx = { agent: agent('ag_1', 'Mira'), runId: 'run_1', mode: 'computer', deviceId: 'dev_2' } as unknown as ToolContext;

test('every device tool exists with the right category, remote flag and visibility', () => {
  const expected = [
    'computer.screenshot', 'computer.windows', 'computer.ui_tree', 'computer.act', 'computer.click', 'computer.type', 'computer.key',
    'computer.scroll', 'computer.drag', 'browser.open', 'browser.snapshot', 'browser.act', 'browser.screenshot', 'browser.extract',
    'browser.tabs', 'browser.batch', 'browser.find', 'browser.console', 'browser.network', 'browser.eval', 'browser.wait', // B-055 Q7 (track E)
    'phone.devices', 'phone.screenshot', 'phone.ui_tree', 'phone.tap', 'phone.swipe', 'phone.type', 'phone.key',
    'phone.open', 'phone.pair', 'phone.connect', 'phone.disconnect', 'devices.list', 'devices.send_file',
    'browser.save_totp', // X05: stores a 2FA key on this PC only
    'browser.save_secret', // B-044: stores a value of this PC's page as the agent's secret (local only)
  ];
  assert.deepEqual([...byName.keys()].sort(), [...expected].sort());
  for (const tool of tools) {
    assert.match(tool.name, /^[a-z][a-z0-9_.-]{0,63}$/);
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.ok(tool.description.length > 20 && tool.description.length < 500, tool.name);
    if (tool.name.startsWith('computer.') || tool.name.startsWith('phone.')) assert.equal(tool.category, 'device', tool.name);
    if ((tool.name.startsWith('computer.') || tool.name.startsWith('browser.')) && tool.name !== 'browser.save_totp' && tool.name !== 'browser.save_secret') assert.equal(tool.remote, true, tool.name);
    if (tool.name !== 'devices.list' && tool.name !== 'devices.send_file') assert.equal(tool.requires, 'device', tool.name);
  }
  // devices.send_file is offered in every mode (tools/types.ts anyMode), so it needs no device mode.
  assert.equal(byName.get('devices.send_file')!.requires, undefined);
  assert.equal(byName.get('devices.send_file')!.anyMode, true);
  for (const name of ['browser.open', 'browser.snapshot', 'browser.screenshot', 'browser.extract', 'browser.tabs', 'browser.find', 'browser.console', 'browser.network', 'browser.wait']) assert.equal(byName.get(name)!.category, 'read');
  for (const name of ['browser.act', 'browser.batch', 'browser.eval']) assert.equal(byName.get(name)!.category, 'device', name);
  assert.equal(byName.get('browser.save_secret')!.category, 'write_local');
  assert.equal(byName.get('browser.save_secret')!.remote, undefined, 'it reads the browser of this PC only');
  assert.equal(byName.get('devices.list')!.category, 'read');
  assert.equal(byName.get('devices.list')!.requires, undefined);
});
