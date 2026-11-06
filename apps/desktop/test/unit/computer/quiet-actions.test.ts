// Pointer-free element steps while the person uses the PC (computer/quiet-actions.ts): the swap
// table, and ComputerService with a fake helper – a click on a button, checkbox or tab runs as its
// pattern action while the person is active (no pointer input, a note for the agent), the same click
// stays a click when the PC is free, and steps without an equal pattern action stay refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComputerService } from '../../../src/runtime/computer/service.ts';
import type { HelperClient } from '../../../src/runtime/computer/helper.ts';
import type { HelperOp } from '../../../src/runtime/computer/protocol.ts';
import type { Host } from '../../../src/runtime/host.ts';
import { humanActive, isPresenceRefusal, judgePresence } from '../../../src/runtime/computer/presence.ts';
import { pointerOrQuiet, quietEquivalent } from '../../../src/runtime/computer/quiet-actions.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

class FakeHelper implements HelperClient {
  calls: Array<{ op: HelperOp; args: Record<string, unknown> }> = [];
  answers: Partial<Record<HelperOp, (args: Record<string, unknown>) => unknown>> = {};
  async call<T>(op: HelperOp, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ op, args });
    const answer = this.answers[op];
    return (answer ? answer(args) : { done: true }) as T;
  }
  running(): boolean { return true; }
  async dispose(): Promise<void> {}
  acts(): unknown[] { return this.calls.filter((call) => call.op === 'act').map((call) => call.args.action); }
}

function setup() {
  const helper = new FakeHelper();
  const h = {
    kind: 'electron', idle: 60,
    encrypt: async () => new Uint8Array(), decrypt: async () => '', notify: async () => false,
    openExternal: async () => {}, openPath: async () => {}, onPower: () => () => {},
    keepAwake: () => () => {}, app: { version: '1.0.0', packaged: false, resourcesDir: '/r', dataDir: '/d', executable: 'node' },
    async idleSeconds(): Promise<number> { return h.idle; },
  } as Host & { idle: number };
  const computer = new ComputerService({
    host: h, supervisor: { spawn: () => { throw new Error('no processes in tests'); } }, resourcesDir: '/r', log: new MemoryLogger(),
    helper, platform: 'win32', now: () => 500_000,
  });
  helper.answers.tree = () => ({
    hwnd: 9, title: 'Editor', truncated: false,
    nodes: [
      { d: 0, p: -1, rid: '1', role: 'window', name: 'Editor' },
      { d: 1, p: 0, rid: '1.1', role: 'button', name: 'Export', patterns: ['invoke'] }, // e2
      { d: 1, p: 0, rid: '1.2', role: 'checkbox', name: 'Loop', toggle: 'off', patterns: ['toggle'] }, // e3
      { d: 1, p: 0, rid: '1.3', role: 'tabitem', name: 'Color', patterns: ['select'] }, // e4
      { d: 1, p: 0, rid: '1.4', role: 'listitem', name: 'clip.mp4', patterns: ['invoke'] }, // e5: Invoke opens it
      { d: 1, p: 0, rid: '1.5', role: 'button', name: 'Canvas' }, // e6: nothing but the pointer
    ],
  });
  helper.answers.act = (args) => ({ exists: true, element: { rid: String(args.rid), role: 'button', name: 'x' } });
  return { computer, helper, host: h };
}

test('quietEquivalent: only a plain click, only where the pattern action is the same step', () => {
  assert.equal(quietEquivalent('click', { role: 'button', patterns: ['invoke'] }), 'invoke');
  assert.equal(quietEquivalent('click', { role: 'hyperlink', patterns: ['invoke'] }), 'invoke');
  assert.equal(quietEquivalent('click', { role: 'menuitem', patterns: ['invoke', 'expand'] }), 'invoke');
  assert.equal(quietEquivalent('click', { role: 'checkbox', patterns: ['toggle'] }), 'toggle');
  for (const role of ['radiobutton', 'tabitem', 'listitem', 'treeitem', 'dataitem']) assert.equal(quietEquivalent('click', { role, patterns: ['select'] }), 'select', role);
  assert.equal(quietEquivalent('click', { role: 'listitem', patterns: ['invoke'] }), undefined, 'invoking a list item opens it; a click selects');
  assert.equal(quietEquivalent('click', { role: 'splitbutton', patterns: ['invoke', 'expand'] }), undefined, 'the click point decides on a split button');
  assert.equal(quietEquivalent('click', { role: 'button' }), undefined, 'patterns unknown');
  assert.equal(quietEquivalent('click', undefined), undefined, 'a name lookup: role and patterns unknown');
  for (const action of ['double_click', 'right_click', 'focus'] as const) assert.equal(quietEquivalent(action, { role: 'button', patterns: ['invoke'] }), undefined, action);
});

test('pointerOrQuiet swaps only for presence refusals, never for other errors', async () => {
  const button = { role: 'button', patterns: ['invoke'] };
  assert.deepEqual(await pointerOrQuiet('click', button, async () => {}), { action: 'click' }, 'free PC: the click stands');
  const swapped = await pointerOrQuiet('click', button, async () => { throw humanActive(); });
  assert.equal(swapped.action, 'invoke');
  assert.match(swapped.note ?? '', /^Ran invoke instead of click: the person is using the PC/);
  const unknown = await pointerOrQuiet('click', button, async () => judgePresence({ idleUnknown: true }));
  assert.match(unknown.note ?? '', /cannot tell whether the person is using it/);
  const other = new WorkforceError('conflict', 'Stopped by the person');
  await assert.rejects(pointerOrQuiet('click', button, async () => { throw other; }), (error) => error === other);
  assert.equal(isPresenceRefusal(other), false);
  assert.equal(isPresenceRefusal(humanActive()), true);
  await assert.rejects(pointerOrQuiet('double_click', button, async () => { throw humanActive(); }), /using the computer/);
});

test('ComputerService.act: while the person works, clicks on button, checkbox and tab run as pattern actions', async () => {
  const { computer, helper, host } = setup();
  await computer.uiTree({ window: 9 });
  host.idle = 0; // the person is typing; our own input was long ago
  const invoked = await computer.act({ ref: 'e2', action: 'click' });
  assert.equal(invoked.action, 'invoke');
  assert.match(invoked.note ?? '', /left the mouse alone/);
  const toggled = await computer.act({ ref: 'e3', action: 'click' });
  assert.equal(toggled.action, 'toggle');
  const selected = await computer.act({ ref: 'e4', action: 'click' });
  assert.equal(selected.action, 'select');
  assert.deepEqual(helper.acts(), ['invoke', 'toggle', 'select']);
  // No equal pattern action: refused as before, nothing reached the helper.
  await assert.rejects(computer.act({ ref: 'e5', action: 'click' }), /using the computer/);
  await assert.rejects(computer.act({ ref: 'e6', action: 'click' }), /using the computer/);
  await assert.rejects(computer.act({ ref: 'e2', action: 'double_click' }), /using the computer/);
  assert.deepEqual(helper.acts(), ['invoke', 'toggle', 'select']);
  // The swapped steps injected nothing: right after them the person's input is still the person's.
  await assert.rejects(computer.click({ x: 5, y: 5 }), /using the computer/);

  host.idle = 60; // the person stepped away: the agent's click stands
  const clicked = await computer.act({ ref: 'e2', action: 'click' });
  assert.equal(clicked.action, 'click');
  assert.equal(clicked.note, undefined);
  assert.deepEqual(helper.acts(), ['invoke', 'toggle', 'select', 'click']);
});
