// The Linux helper's pointer paths (B-055, resources/computer/linux_path.py) run for real under
// Python against a scripted pointer (linux-path-check.py): steps on time, a click held for pressMs
// with the double-click gap, the person moving the mouse mid-path or since the plan ('human_active',
// nothing pressed), a drag cut by the person (let go at once, 'conflict'), wheel steps at the end,
// no checks without pointer reads, refused malformed paths, and an element click bent onto the
// element's centre. Skips without a Python interpreter; a real X server is not covered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const resources = path.resolve(here, '..', '..', '..', 'resources');
const python = ['python3', 'python'].find((command) => spawnSync(command, ['--version']).status === 0);

type Case = { case: string; ok: boolean; code?: string; message?: string; value?: { at?: number[] } | null; events: unknown[][]; guarded: number[][][] };

test('Linux pointer paths: timing, presses, the person first, drags always let go', { skip: python ? false : 'no Python interpreter' }, () => {
  const out = spawnSync(python!, ['-B', path.join(here, 'linux-path-check.py'), path.join(resources, 'computer')], {
    env: { ...process.env, PYTHONPATH: path.join(here, 'fake-gi'), DISPLAY: '' }, encoding: 'utf8',
  });
  assert.equal(out.status, 0, out.stderr);
  const cases = new Map(out.stdout.trim().split(/\r?\n/).map((line): [string, Case] => { const item = JSON.parse(line) as Case; return [item.case, item]; }));
  const get = (name: string) => { const item = cases.get(name); assert.ok(item, name); return item; };
  const kinds = (item: Case) => item.events.map((event) => event[0]);

  const move = get('move on time');
  assert.equal(move.ok, true);
  assert.deepEqual(move.events.map((event) => [event[1], event[2]]), [[0, 0], [10, 0], [20, 0]], 'every step, the last one exact');
  const times = move.events.map((event) => event[3] as number);
  assert.ok(times.every((t, i) => i === 0 || t >= times[i - 1]!), 'time never runs back');
  assert.ok(times[2]! >= 55, `the last step waits for its time (${times[2]} ms)`);

  const click = get('double click holds');
  assert.deepEqual(kinds(click), ['move', 'move', 'move', 'p', 'r', 'p', 'r']);
  const [p1, r1, p2] = click.events.slice(3).map((event) => event[4] as number);
  assert.ok(r1! - p1! >= 45, 'the button is held for pressMs');
  assert.ok(p2! - r1! >= 25, 'the double-click gap');
  assert.deepEqual(click.guarded, [[[20, 0]]], 'the press point passed the Workforce check before anything moved');

  const interrupted = get('person moves mid-path');
  assert.deepEqual([interrupted.ok, interrupted.code], [false, 'human_active']);
  assert.ok(!kinds(interrupted).includes('p'), 'nothing was pressed');
  const before = get('person moved before');
  assert.deepEqual([before.code, before.events.length], ['human_active', 0], 'the pointer is not where the plan started: nothing moves');

  const cut = get('drag cut by the person');
  assert.deepEqual([cut.ok, cut.code], [false, 'conflict']);
  assert.match(cut.message ?? '', /let go early/);
  assert.deepEqual(kinds(cut).filter((kind) => kind !== 'move'), ['p', 'r'], 'the held button is always released');
  assert.deepEqual(get('drag').events.filter((event) => event[0] !== 'move').map((event) => [event[0], event[1], event[2], event[3]]), [['p', 0, 0, 3], ['r', 30, 0, 3]], 'pressed at the start, released at the end');
  assert.deepEqual(get('drag').guarded, [[[0, 0], [30, 0]]], 'both ends checked before the button goes down');

  assert.deepEqual(get('wheel at the end').events.at(-1)!.slice(0, 5), ['wheel', 20, 0, 0, 3]);
  assert.equal(get('no pointer reads').ok, true, 'without pointer reads (no X11) the path just runs');
  assert.deepEqual([get('t falls').code, get('not numbers').code, get('bad end').code], ['bad_request', 'bad_request', 'bad_request']);
  assert.equal(get('t falls').events.length, 0);

  const bent = get('element click bent');
  assert.deepEqual(bent.events.filter((event) => event[0] === 'move').map((event) => [event[1], event[2]]), [[0, 0], [55, 45], [110, 90]], 'the start stays, the end is the element\'s centre');
  assert.deepEqual(kinds(bent).slice(-2), ['p', 'r']);
});
