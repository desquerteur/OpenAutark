// The real PC pointer's motion (B-055 Q9, computer/motion.ts + pointer-input.ts): the helper 'path'
// request a click, move, drag or scroll becomes (flat whole-pixel steps, t never falling, at most
// MAX_PATH_STEPS, the pointer read first and named as `from`), the press, dwell and double-click
// timing, a drag that never overshoots, the person moving the mouse mid-path as the presence
// refusal, an element click with a planned path, `motion` validation (tool schema and service), and
// the named pointers (Q8): agent moves with their path on 'screen:local', the person's pointer, and
// the line about others under computer.* results.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clickPath, dragPath, flatSteps, MAX_PATH_STEPS, movePath, pathTimeout, retime, wheelPath } from '../../../src/runtime/computer/motion.ts';
import { ComputerService } from '../../../src/runtime/computer/service.ts';
import { computerTools } from '../../../src/runtime/computer/tools.ts';
import { isPresenceRefusal } from '../../../src/runtime/computer/presence.ts';
import { SCREEN_SURFACE } from '../../../src/runtime/computer/screen-pointers.ts';
import type { HelperClient } from '../../../src/runtime/computer/helper.ts';
import type { HelperOp } from '../../../src/runtime/computer/protocol.ts';
import type { Host } from '../../../src/runtime/host.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { validate } from '../../../src/runtime/tools/validate.ts';
import { PointerHub } from '../../../src/runtime/pointers/hub.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { planMotion } from '../../../src/shared/model/pointer-motion.ts';
import { POINTER_PATH_MAX } from '../../../src/shared/model/pointers.ts';
import { agent } from '../chat/harness.ts';

type Call = { op: HelperOp; args: Record<string, unknown>; timeoutMs?: number };

class FakeHelper implements HelperClient {
  calls: Call[] = [];
  answers: Partial<Record<HelperOp, (args: Record<string, unknown>) => unknown>> = {};
  async call<T>(op: HelperOp, args: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<T> {
    this.calls.push({ op, args, timeoutMs: options.timeoutMs });
    const answer = this.answers[op];
    return (answer ? answer(args) : { done: true }) as T;
  }
  running(): boolean { return true; }
  async dispose(): Promise<void> {}
  ops(): string[] { return this.calls.map((call) => call.op); }
  last(op: HelperOp): Call { return this.calls.filter((call) => call.op === op).at(-1)!; }
}

function rig(options: { hub?: boolean } = {}) {
  let now = 2_000_000;
  const helper = new FakeHelper();
  const host = {
    kind: 'electron', encrypt: async () => new Uint8Array(), decrypt: async () => '', notify: async () => false,
    openExternal: async () => {}, openPath: async () => {}, onPower: () => () => {}, keepAwake: () => () => {},
    app: { version: '1.0.0', packaged: false, resourcesDir: '/r', dataDir: '/d', executable: 'node' },
    async idleSeconds() { return 60; },
  } as Host;
  const hub = new PointerHub({ now: () => now });
  const services = options.hub ? (() => ({ pointers: hub, settings: { get: () => ({ profile: { name: 'Lukas' } }) } }) as unknown as RuntimeServices) : undefined;
  const computer = new ComputerService({
    host, supervisor: { spawn: () => { throw new Error('no processes in tests'); } }, resourcesDir: '/r', log: new MemoryLogger(), helper, platform: 'win32', now: () => now, services,
  });
  helper.answers.cursor = () => ({ x: 100, y: 100, idleMs: 60_000, injectedAgoMs: null });
  helper.answers.path = (args) => { const steps = args.steps as number[]; return { done: true, at: steps.slice(-3, -1), window: 77, title: 'Notes' }; };
  return { computer, helper, hub, tick: (ms: number) => { now += ms; } };
}

const ada = { key: 'ag_ada', id: 'ag_ada', name: 'Ada' };

/** [x, y, t] triples of a flat wire path. */
const triples = (flat: number[]) => Array.from({ length: flat.length / 3 }, (_v, i) => flat.slice(i * 3, i * 3 + 3) as [number, number, number]);

test('flatSteps: whole pixels and ms, t never falls, at most MAX_PATH_STEPS with the exact last step', () => {
  assert.deepEqual(flatSteps([{ x: 1.4, y: 2.6, t: 3.5 }, { x: 10, y: 20, t: 3.2 }, { x: 11, y: 21, t: 9 }]), [1, 3, 4, 10, 20, 4, 11, 21, 9]);
  const long = retime(planMotion({ x: 0, y: 0 }, { x: 1800, y: 900 }, { style: 'human', correct: false, stepMs: 4, pace: 4 }), 9000);
  assert.ok(long.length > MAX_PATH_STEPS);
  const flat = triples(flatSteps(long));
  assert.equal(flat.length, MAX_PATH_STEPS);
  assert.deepEqual(flat.at(-1), [1800, 900, 9000]);
  assert.ok(flat.every(([x, y, t], i) => Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(t) && (i === 0 || t >= flat[i - 1]![2])));
});

test('click, move and wheel paths: from where the pointer was, the style\'s hold, dwell and double-click gap', () => {
  const human = clickPath({ x: 10, y: 10 }, { x: 600, y: 400 }, 'human', { count: 2, button: 'right', targetSize: 30 });
  assert.deepEqual([human.args.end, human.args.from, human.args.button, human.args.count], ['click', [10, 10], 'right', 2]);
  assert.ok(human.args.pressMs! >= 55 && human.args.pressMs! <= 120, 'a hand holds the button 55–120 ms');
  assert.ok(human.args.dwellMs! >= 40 && human.args.gapMs! >= 70 && human.args.gapMs! < 110);
  assert.deepEqual(triples(human.args.steps).at(-1)!.slice(0, 2), [600, 400]);
  const travel = triples(human.args.steps).at(-1)![2];
  assert.equal(human.ms, travel + human.args.dwellMs! + 2 * human.args.pressMs! + human.args.gapMs!);
  assert.equal(pathTimeout(human), human.ms + 10_000);
  const glide = clickPath({ x: 10, y: 10 }, { x: 600, y: 400 }, 'glide');
  assert.deepEqual([glide.args.pressMs, glide.args.dwellMs, glide.args.count, glide.args.button], [25, 20, 1, 'left'], 'a glide presses briefly after a short beat');
  assert.ok(triples(glide.args.steps).at(-1)![2] <= 420);
  const jump = clickPath(undefined, { x: 600, y: 400 }, 'human');
  assert.deepEqual([jump.args.steps, jump.args.from], [[600, 400, 0], undefined], 'pointer unknown: a jump, nothing to check');
  assert.deepEqual(movePath({ x: 0, y: 0 }, { x: 50, y: 0 }, 'glide').args.end, 'none');
  const wheel = wheelPath({ x: 0, y: 0 }, { x: 50, y: 0 }, 'glide', 0, -3);
  assert.deepEqual([wheel.args.end, wheel.args.dx, wheel.args.dy], ['wheel', 0, -3]);
});

test('drags: to the start, pressed, along a path that never overshoots, as long as asked', () => {
  const from = { x: 100, y: 500 }, to = { x: 1500, y: 520 };
  for (let pointer = 0; pointer < 5; pointer += 1) {
    const planned = dragPath({ x: pointer * 37, y: 20 }, from, to, 'human');
    const held = triples(planned.args.drag!);
    assert.deepEqual(held.at(-1)!.slice(0, 2), [1500, 520]);
    assert.ok(Math.max(...held.map(([x]) => x)) <= 1500 + 1, 'no overshoot past the drop target (correct: false)');
    assert.deepEqual(triples(planned.args.steps).at(-1)!.slice(0, 2), [100, 500], 'the approach ends at the drag start');
  }
  const timed = dragPath(undefined, from, to, 'glide', { durationMs: 2000, button: 'middle' });
  assert.equal(triples(timed.args.drag!).at(-1)![2], 2000, 'durationMs sets the held part');
  assert.deepEqual([timed.args.button, timed.args.steps, timed.args.downMs, timed.args.settleMs], ['middle', [100, 500, 0], 60, 60]);
  const quick = dragPath(undefined, from, to, 'instant');
  assert.ok(triples(quick.args.drag!).length > 1 && triples(quick.args.drag!).at(-1)![2] <= 110, 'instant: the shortest glide, a jump does not drag');
});

test('ComputerService: a glide click reads the pointer, then replays the whole path in one request', async () => {
  const r = rig();
  const done = await r.computer.click({ x: 640, y: 360, caller: ada });
  assert.deepEqual(r.helper.ops(), ['cursor', 'path']);
  const path = r.helper.last('path');
  assert.deepEqual([path.args.end, path.args.from, path.args.button, path.args.count], ['click', [100, 100], 'left', 1]);
  const steps = triples(path.args.steps as number[]);
  assert.ok(steps.length > 3 && steps[0]![2] > 0);
  assert.deepEqual(steps.at(-1)!.slice(0, 2), [640, 360]);
  assert.ok(path.timeoutMs! >= steps.at(-1)![2] + 10_000, 'the helper gets the path\'s time plus a margin');
  assert.deepEqual([done.x, done.y, done.window], [640, 360, 77]);

  await r.computer.click({ x: 640, y: 360, motion: 'instant' });
  assert.equal(r.helper.ops().at(-1), 'click', 'instant: the old one-shot op, no pointer read');
  await r.computer.scroll({ x: 300, y: 200, dy: 3, motion: 'human' });
  assert.deepEqual([r.helper.last('path').args.end, r.helper.last('path').args.dy], ['wheel', 3]);
  await r.computer.scroll({ dy: 2 });
  assert.equal(r.helper.ops().at(-1), 'scroll', 'without a point the wheel turns where the pointer is');
  await r.computer.move({ x: 5, y: 5 });
  assert.equal(r.helper.last('path').args.end, 'none');
  await r.computer.drag({ x1: 10, y1: 10, x2: 300, y2: 10, durationMs: 500 });
  const drag = r.helper.last('path');
  assert.deepEqual([drag.args.end, triples(drag.args.drag as number[]).at(-1)], ['drag', [300, 10, 500]]);

  r.helper.answers.cursor = () => { throw new WorkforceError('unavailable', 'no X11'); };
  await r.computer.click({ x: 50, y: 60 });
  assert.deepEqual([r.helper.last('path').args.steps, r.helper.last('path').args.from], [[50, 60, 0], undefined], 'pointer unknown: it jumps');
  await assert.rejects(r.computer.click({ x: 1, y: 1, motion: 'fast' as never }), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request' && /motion must be/.test(error.message));
});

test('the person moving the mouse mid-path is their priority: the presence refusal, nothing pressed', async () => {
  const r = rig();
  r.helper.answers.path = () => { throw new WorkforceError('conflict', 'The person moved the mouse, so the pointer stopped on its way and nothing was pressed.', { details: { humanActive: true } }); };
  await assert.rejects(r.computer.click({ x: 640, y: 360 }), (error: unknown) => {
    assert.ok(isPresenceRefusal(error), 'marked like every presence refusal (a computer.act click can swap to its pattern action)');
    assert.match((error as Error).message, /^The person is using the computer – retrying later/);
    return true;
  });
  // A drag the person cut mid-way passes on as it is: the effect needs a look.
  r.helper.answers.path = () => { throw new WorkforceError('conflict', 'The person moved the mouse during the drag, so it was let go early at 5,5. Look at the screen before you go on.'); };
  await assert.rejects(r.computer.drag({ x1: 0, y1: 0, x2: 50, y2: 0 }), (error: unknown) => !isPresenceRefusal(error) && /let go early/.test((error as Error).message));
});

test('an element click travels to the observed element; the helper bends the path onto its clickable point', async () => {
  const r = rig();
  r.helper.answers.tree = () => ({ hwnd: 9, title: 'Editor', nodes: [{ d: 0, p: -1, rid: '1', role: 'window', name: 'Editor' }, { d: 1, p: 0, rid: '1.1', role: 'button', name: 'Export', patterns: ['invoke'], rect: [400, 300, 80, 30] }] });
  r.helper.answers.act = () => ({ exists: true, element: { rid: '1.1', role: 'button', name: 'Export' }, at: [441, 316] });
  await r.computer.uiTree({ window: 9, caller: ada });
  await r.computer.act({ ref: 'e2', action: 'double_click', caller: ada, motion: 'human', settleMs: 0 });
  assert.deepEqual(r.helper.ops(), ['tree', 'cursor', 'act']);
  const act = r.helper.last('act');
  const path = act.args.path as { steps: number[]; from: number[]; count: number; end: string };
  assert.deepEqual([act.args.action, act.args.expectName, path.from, path.count], ['double_click', 'Export', [100, 100], 2]);
  assert.deepEqual(triples(path.steps).at(-1)!.slice(0, 2), [440, 315], 'planned to the observed centre');
  assert.ok(act.timeoutMs! > 30_000, 'the path\'s time on top');
  await r.computer.act({ ref: 'e2', action: 'click', caller: ada, motion: 'instant', settleMs: 0 });
  assert.equal(r.helper.last('act').args.path, undefined, 'instant: the helper jumps as before');
  await r.computer.act({ ref: 'e2', action: 'invoke', caller: ada, settleMs: 0 });
  assert.equal(r.helper.ops().filter((op) => op === 'cursor').length, 1, 'pattern actions never read or move the pointer');
});

test('motion is validated by the tool schema: instant, glide or human only', () => {
  const tools = new Map(computerTools({} as ComputerService).map((tool) => [tool.name, tool]));
  for (const name of ['computer.click', 'computer.drag', 'computer.scroll', 'computer.act']) {
    const schema = tools.get(name)!.inputSchema;
    const base = name === 'computer.act' ? { action: 'click', ref: 'e1' } : name === 'computer.scroll' ? { dy: 1 } : name === 'computer.click' ? { x: 1, y: 1 } : { x1: 0, y1: 0, x2: 1, y2: 1 };
    for (const motion of ['instant', 'glide', 'human']) assert.deepEqual(validate({ ...base, motion }, schema), [], `${name} ${motion}`);
    assert.ok(validate({ ...base, motion: 'fast' }, schema).length > 0, `${name} refuses "fast"`);
    assert.ok(validate({ ...base, motion: 3 }, schema).length > 0);
    const description = (schema.properties as Record<string, { description?: string }>).motion!.description!;
    assert.ok(description.length < 200 && /real mouse movement/.test(description), 'one short sentence (B-078 T7: human = real mouse movement)');
  }
  assert.equal((tools.get('computer.type')!.inputSchema.properties as Record<string, unknown>).motion, undefined, 'keys and typing do not travel');
});

test('named pointers: agent moves with their path on screen:local, the person when active, and a line about others under results', async () => {
  const r = rig({ hub: true });
  await r.computer.click({ x: 640, y: 360, caller: ada, motion: 'human' });
  const [point] = r.hub.on(SCREEN_SURFACE);
  assert.deepEqual([point!.actor, point!.x, point!.y, point!.action], [{ kind: 'agent', id: 'ag_ada', name: 'Ada' }, 640, 360, 'click']);
  assert.ok(point!.path!.length > 1 && point!.path!.length <= POINTER_PATH_MAX, 'the path travels along (thinned) so viewers animate the same motion');
  assert.deepEqual({ x: point!.path!.at(-1)!.x, y: point!.path!.at(-1)!.y }, { x: 640, y: 360 });

  // Another agent reads Ada in its results (every computer.* tool), Ada reads nobody.
  const tools = new Map(computerTools(r.computer).map((tool) => [tool.name, tool]));
  r.helper.answers.windows = () => [];
  const ctx = (id: string, name: string) => ({ agent: agent(id, name), runId: 'run_1', mode: 'computer', signal: new AbortController().signal, status() {} }) as unknown as ToolContext;
  r.tick(3000);
  const other = await tools.get('computer.windows')!.run({}, ctx('ag_ben', 'Ben'));
  assert.equal((other.content[0] as { text: string }).text, 'No visible windows.\nAda (agent) clicked at 640,360, 3 s ago');
  const own = await tools.get('computer.windows')!.run({}, ctx('ag_ada', 'Ada'));
  assert.equal((own.content[0] as { text: string }).text, 'No visible windows.');

  // The person's input is newer than ours when the pointer is read: their pointer is reported too.
  r.helper.answers.cursor = () => ({ x: 900, y: 50, idleMs: 400, injectedAgoMs: 5000 });
  await r.computer.move({ x: 10, y: 10, caller: ada });
  const person = r.hub.on(SCREEN_SURFACE).find((p) => p.actor.kind === 'person');
  assert.deepEqual([person?.actor.name, person?.x, person?.y], ['Lukas', 900, 50]);
  const line = r.computer.othersLine({ key: 'ag_ben', id: 'ag_ben', name: 'Ben' });
  assert.match(line, /^Ada \(agent\) is pointing at 10,10, just now$/m);
  assert.match(line, /^Lukas \(person\) is pointing at 900,50, just now$/m);
  assert.equal(r.computer.othersLine({ key: 'ag_ada', id: 'ag_ada', name: 'Ada' }), 'Lukas (person) is pointing at 900,50, just now');

  // Our own input was the newest: the pointer is ours, nobody else is reported.
  const fresh = rig({ hub: true });
  fresh.helper.answers.cursor = () => ({ x: 900, y: 50, idleMs: 400, injectedAgoMs: 450 });
  await fresh.computer.move({ x: 10, y: 10, caller: ada });
  assert.equal(fresh.hub.on(SCREEN_SURFACE).some((p) => p.actor.kind === 'person'), false);
});
