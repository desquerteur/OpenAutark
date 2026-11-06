// Several agents on one PC (B-055 Q10): the pointer lease (computer/lease.ts) – one agent holds mouse
// and keyboard until LEASE_TTL_MS after its last such step, another agent's pointer or keyboard step
// is refused with one sentence naming the holder and its window, pattern actions run in parallel (a
// computer.act click swaps to its pattern action), linked-PC agents count as callers of their own;
// the window memory note (window-memory.ts) and each agent's own refs (service.ts, tree.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callerOf, isLeaseRefusal, LEASE_TTL_MS, PointerLease, type ComputerCaller } from '../../../src/runtime/computer/lease.ts';
import { WINDOW_NOTE_MS, WindowMemory } from '../../../src/runtime/computer/window-memory.ts';
import { ComputerService } from '../../../src/runtime/computer/service.ts';
import { computerTools } from '../../../src/runtime/computer/tools.ts';
import type { HelperClient } from '../../../src/runtime/computer/helper.ts';
import type { HelperOp } from '../../../src/runtime/computer/protocol.ts';
import type { Host } from '../../../src/runtime/host.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { agent } from '../chat/harness.ts';

const ada: ComputerCaller = { key: 'ag_ada', id: 'ag_ada', name: 'Ada' };
const ben: ComputerCaller = { key: 'ag_ben', id: 'ag_ben', name: 'Ben' };

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
  ops(): string[] { return this.calls.map((call) => call.op); }
}

function rig() {
  let now = 1_000_000;
  const helper = new FakeHelper();
  const host = {
    kind: 'electron', encrypt: async () => new Uint8Array(), decrypt: async () => '', notify: async () => false,
    openExternal: async () => {}, openPath: async () => {}, onPower: () => () => {}, keepAwake: () => () => {},
    app: { version: '1.0.0', packaged: false, resourcesDir: '/r', dataDir: '/d', executable: 'node' },
    async idleSeconds() { return 60; },
  } as Host;
  const computer = new ComputerService({
    host, supervisor: { spawn: () => { throw new Error('no processes in tests'); } }, resourcesDir: '/r', log: new MemoryLogger(), helper, platform: 'win32', now: () => now,
  });
  helper.answers.windows = () => [{ hwnd: 77, title: 'Invoice.xlsx - Excel', process: 'excel', pid: 1, foreground: true }];
  helper.answers.tree = () => ({
    hwnd: 77, title: 'Invoice.xlsx - Excel', truncated: false,
    nodes: [
      { d: 0, p: -1, rid: '1', role: 'window', name: 'Invoice.xlsx - Excel' },
      { d: 1, p: 0, rid: '1.1', role: 'button', name: 'Save', patterns: ['invoke'], rect: [10, 10, 40, 20] },
      { d: 1, p: 0, rid: '1.2', role: 'edit', name: 'Total', value: '1', patterns: ['value'], rect: [10, 40, 80, 20] },
    ],
  });
  helper.answers.act = (args) => ({ exists: true, element: { rid: String(args.rid), role: 'button', name: 'Save' }, at: [30, 20] });
  return { computer, helper, tick: (ms: number) => { now += ms; }, now: () => now };
}

const instant = { motion: 'instant' as const };

test('callerOf: an agent of this PC by its id; an agent of a linked PC by that PC and its id', () => {
  assert.deepEqual(callerOf({ agent: { id: 'ag_1', name: 'Mira' } }), { key: 'ag_1', id: 'ag_1', name: 'Mira' });
  assert.deepEqual(callerOf({ agent: { id: 'ag_1', name: 'Mira (Laptop)' }, fromPc: 'Laptop' }), { key: 'Laptop/ag_1', id: 'ag_1', name: 'Mira (Laptop)', fromPc: 'Laptop' });
});

test('PointerLease: one holder, renewed per step, held while a step runs, free LEASE_TTL_MS after the last one', () => {
  let now = 0;
  const titles = new Map([[77, 'Invoice.xlsx - Excel']]);
  const lease = new PointerLease({ now: () => now, titleOf: (hwnd) => titles.get(hwnd) });
  lease.check(ben); // free
  const end = lease.begin(ada, 77);
  assert.throws(() => lease.check(ben), (error: unknown) => {
    assert.ok(error instanceof WorkforceError && isLeaseRefusal(error));
    assert.equal(error.code, 'conflict');
    assert.equal(error.message, 'Ada (agent) is using the mouse and keyboard on this PC right now (in "Invoice.xlsx - Excel") – use computer.act pattern actions (invoke, set_value, toggle, select, expand), which run in the background without the mouse, or retry in a few seconds.');
    assert.deepEqual(error.details, { lease: { holder: 'Ada' } });
    return true;
  });
  now += 60_000;
  assert.throws(() => lease.check(ben), /Ada \(agent\) is using the mouse/, 'a long step holds the lease while it runs');
  lease.check(ada); // the holder itself is never refused
  lease.check(undefined); // internal calls name no caller
  end();
  end(); // ending twice changes nothing
  now += LEASE_TTL_MS - 1;
  assert.throws(() => lease.begin(ben), (error: unknown) => isLeaseRefusal(error) && (error as WorkforceError).retryAfterMs! >= 1000);
  assert.equal(lease.current()?.caller.name, 'Ada');
  now += 1;
  assert.equal(lease.current(), undefined, 'run out');
  const benEnd = lease.begin(ben);
  benEnd();
  assert.throws(() => lease.check(ada), /^WorkforceError: Ben \(agent\) is using the mouse and keyboard on this PC right now – use/, 'no window known: none named');
  assert.equal(isLeaseRefusal(new WorkforceError('conflict', 'x')), false);
});

test('two agents: the second one\'s pointer and keyboard steps are refused while the first holds the lease; pattern actions run in parallel', async () => {
  const r = rig();
  await r.computer.windows();
  await r.computer.uiTree({ window: 77, caller: ada });
  await r.computer.act({ ref: 'e2', action: 'click', caller: ada, ...instant }); // Ada's click on Save holds the lease (window 77)
  const sent = r.helper.calls.length;

  const refused = (error: unknown) => error instanceof WorkforceError && isLeaseRefusal(error) && /^Ada \(agent\) is using the mouse and keyboard on this PC right now \(in "Invoice\.xlsx - Excel"\)/.test(error.message);
  await assert.rejects(r.computer.click({ x: 5, y: 5, caller: ben, ...instant }), refused);
  await assert.rejects(r.computer.move({ x: 5, y: 5, caller: ben }), refused);
  await assert.rejects(r.computer.drag({ x1: 0, y1: 0, x2: 9, y2: 9, caller: ben }), refused);
  await assert.rejects(r.computer.scroll({ dy: 2, caller: ben }), refused);
  await assert.rejects(r.computer.type({ text: 'hi', caller: ben }), refused);
  await assert.rejects(r.computer.key({ combo: 'enter', caller: ben }), refused);
  await assert.rejects(r.computer.focusWindow(77, undefined, ben), refused);
  await assert.rejects(r.computer.act({ window: 77, name: 'Excel', action: 'window_minimize', caller: ben }), refused, 'moving windows changes what the holder reaches');
  assert.equal(r.helper.calls.length, sent, 'nothing reached the helper');

  // Pattern actions need neither mouse nor keyboard: Ben works in parallel.
  await r.computer.uiTree({ window: 77, caller: ben });
  const benSave = r.helper.calls.length;
  const set = await r.computer.act({ ref: 'e6', action: 'set_value', value: '2', caller: ben, settleMs: 0 }); // Ben's refs: e4 window, e5 Save, e6 Total
  assert.equal(set.action, 'set_value');
  const swapped = await r.computer.act({ ref: 'e5', action: 'click', caller: ben, settleMs: 0 });
  assert.equal(swapped.action, 'invoke', 'Ben\'s click on a button runs as its invoke');
  assert.match(swapped.note ?? '', /^Ran invoke instead of click: Ada is using the mouse and keyboard, so this step used the element's own invoke action and left the mouse alone\./);
  assert.deepEqual(r.helper.calls.slice(benSave).map((call) => call.args.action), ['set_value', 'invoke']);

  // Ada goes on; a linked PC's agent with the same id is someone else.
  await r.computer.click({ x: 5, y: 5, caller: ada, ...instant });
  await assert.rejects(r.computer.click({ x: 5, y: 5, caller: { ...ada, key: 'Laptop/ag_ada', name: 'Ada (Laptop)', fromPc: 'Laptop' }, ...instant }), refused);

  r.tick(LEASE_TTL_MS + 1);
  await r.computer.click({ x: 5, y: 5, caller: ben, ...instant });
  await assert.rejects(r.computer.click({ x: 5, y: 5, caller: ada, ...instant }), /^WorkforceError: Ben \(agent\) is using the mouse/, 'now Ben holds it');
  await r.computer.click({ x: 5, y: 5, ...instant }); // an internal call names no caller: never leased
});

test('the window memory: a step in a window another agent used less than a minute ago says so, in one line', async () => {
  const r = rig();
  await r.computer.uiTree({ window: 77, caller: ada });
  const first = await r.computer.act({ ref: 'e2', action: 'invoke', caller: ada, settleMs: 0 });
  assert.equal(first.shared, undefined, 'nobody else was there');
  r.tick(12_000);
  const tree = await r.computer.uiTree({ window: 77, caller: ben });
  assert.equal(tree.shared, 'Ada (agent) worked in this window 12 s ago.', 'reading tells it too');
  const second = await r.computer.act({ ref: 'e5', action: 'invoke', caller: ben, settleMs: 0 });
  assert.equal(second.shared, 'Ada (agent) worked in this window 12 s ago.');
  assert.equal((await r.computer.act({ ref: 'e5', action: 'invoke', caller: ben, settleMs: 0 })).shared, undefined, 'its own steps are no news');
  r.tick(WINDOW_NOTE_MS);
  assert.equal((await r.computer.uiTree({ window: 77, caller: ada })).shared, undefined, 'older than a minute: no note');

  const memory = new WindowMemory({ now: () => 0 });
  assert.equal(memory.use(ada, 5), '');
  assert.equal(memory.use(ben, 5), 'Ada (agent) worked in this window just now.');
  assert.equal(memory.note(undefined, 5), '', 'an internal call gets no note');
  memory.title(5, 'Notes');
  assert.equal(memory.titleOf(5), 'Notes');
});

test('each agent has its own refs: another agent\'s later read can never change what a ref expects', async () => {
  const r = rig();
  const mine = await r.computer.uiTree({ window: 77, caller: ada });
  assert.match(mine.text, /button "Save" \[ref=e2\]/);
  // The same button, renamed meanwhile, read by Ben: a new ref of Ben's own.
  r.helper.answers.tree = () => ({ hwnd: 77, title: 'Invoice.xlsx - Excel', nodes: [{ d: 0, p: -1, rid: '1', role: 'window', name: 'Invoice.xlsx - Excel' }, { d: 1, p: 0, rid: '1.1', role: 'button', name: 'Delete', patterns: ['invoke'] }] });
  const theirs = await r.computer.uiTree({ window: 77, caller: ben });
  assert.match(theirs.text, /button "Delete" \[ref=e5\]/, 'one counter: a ref names exactly one agent\'s observation');
  assert.equal(r.computer.elementRect('e2', ada)?.[0], 10, 'anchors read the caller\'s own observation');
  assert.equal(r.computer.elementRect('e2', ben), undefined);
  await r.computer.act({ ref: 'e2', action: 'invoke', caller: ada, settleMs: 0 });
  assert.equal(r.helper.calls.at(-1)!.args.expectName, 'Save', 'Ada\'s ref still expects what Ada saw (the helper refuses a renamed element)');
  await assert.rejects(r.computer.act({ ref: 'e2', action: 'invoke', caller: ben }), /Unknown ref "e2"/, 'Ada\'s ref is not Ben\'s');
  // Without a caller (internal calls) the shared default table works as before.
  const plain = await r.computer.uiTree({ window: 77 });
  assert.match(plain.text, /\[ref=e7\]/);
  await r.computer.act({ ref: 'e7', action: 'invoke', settleMs: 0 });
});

test('computer.* tools name their caller: a linked PC\'s agent is refused like any other while one holds the lease', async () => {
  const r = rig();
  const tools = new Map(computerTools(r.computer).map((tool) => [tool.name, tool]));
  const click = tools.get('computer.click')!;
  const ctx = (id: string, name: string, fromPc?: string) => ({ agent: agent(id, name), runId: 'run_1', mode: 'computer', signal: new AbortController().signal, status() {}, ...(fromPc ? { fromPc } : {}) }) as unknown as ToolContext;
  const out = await click.run({ x: 5, y: 6, motion: 'instant' }, ctx('ag_mira', 'Mira'));
  assert.match((out.content[0] as { text: string }).text, /^Clicked left at screen 5,6\./);
  await assert.rejects(click.run({ x: 5, y: 6, motion: 'instant' }, ctx('ag_mira', 'Mira (Laptop)', 'Laptop')), /^WorkforceError: Mira \(agent\) is using the mouse and keyboard on this PC right now/);
  await assert.rejects(tools.get('computer.type')!.run({ text: 'x' }, ctx('ag_jo', 'Jo')), /Mira \(agent\) is using the mouse/);
});
