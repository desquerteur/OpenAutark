// Precise pointer steps (23.10.2026, computer/anchors.ts + computer.drag / computer.scroll): points
// as fractions inside an observed element's rectangle (kept inside its edges), a drag from one
// element onto another or by an exact offset, a wheel scroll over an element – and clear refusals
// for unknown refs, elements without a position and incomplete arguments. Coordinates still work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorPoint, dragPoints } from '../../../src/runtime/computer/anchors.ts';
import type { ComputerService } from '../../../src/runtime/computer/service.ts';
import { computerTools } from '../../../src/runtime/computer/tools.ts';
import type { ToolContext, ToolDef } from '../../../src/runtime/tools/types.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { agent } from '../chat/harness.ts';

const RECTS: Record<string, [number, number, number, number]> = { e1: [100, 200, 40, 20], e2: [600, 210, 400, 30], e3: [0, 0, 0, 0] };
const rectOf = (ref: string) => RECTS[ref];

test('anchors: fractions inside the rectangle, never outside its edges; offsets are exact', () => {
  assert.deepEqual(anchorPoint(RECTS.e1, {}), { x: 120, y: 210 });
  assert.deepEqual(anchorPoint(RECTS.e2, { x: 0.3, y: 0.5 }), { x: 720, y: 225 });
  assert.deepEqual(anchorPoint(RECTS.e1, { x: 1, y: 1 }), { x: 139, y: 219 }, 'one pixel inside');
  assert.deepEqual(dragPoints({ ref: 'e1' }, { ref: 'e2', x: 0 }, rectOf), { from: { x: 120, y: 210 }, to: { x: 600, y: 225 } });
  assert.deepEqual(dragPoints({ ref: 'e1', x: 0.25 }, { dx: 37, dy: -5 }, rectOf), { from: { x: 110, y: 210 }, to: { x: 147, y: 205 } });
  assert.throws(() => anchorPoint(RECTS.e3, {}), (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable');
  assert.throws(() => dragPoints({ ref: 'e9' }, { dx: 1, dy: 0 }, rectOf), (error: unknown) => error instanceof WorkforceError && error.code === 'not_found');
  assert.throws(() => dragPoints({ ref: 'e1' }, { dx: 0, dy: 0 }, rectOf), /at least one pixel/);
  assert.throws(() => anchorPoint(RECTS.e1, { x: 1.5 }), /fraction/);
});

test('computer.drag and computer.scroll by element refs; coordinates still work; incomplete arguments are refused', async () => {
  const drags: Array<Record<string, unknown>> = [];
  const scrolls: Array<Record<string, unknown>> = [];
  const computer = {
    elementRect: rectOf,
    drag: async (input: { x1: number; y1: number; x2: number; y2: number }) => { drags.push(input); return { from: { x: input.x1, y: input.y1 }, to: { x: input.x2, y: input.y2 } }; },
    scroll: async (input: Record<string, unknown>) => { scrolls.push(input); },
  } as unknown as ComputerService;
  const tools = new Map(computerTools(computer).map((tool) => [tool.name, tool] as [string, ToolDef]));
  const ctx = { agent: agent('ag_1', 'Mira'), runId: 'run_1', mode: 'computer', signal: new AbortController().signal, status() {} } as unknown as ToolContext;
  const drag = tools.get('computer.drag')!;
  const scroll = tools.get('computer.scroll')!;

  await drag.run({ from: { ref: 'e1' }, to: { ref: 'e2', x: 0.3 }, durationMs: 600 }, ctx);
  assert.deepEqual(drags.at(-1), { x1: 120, y1: 210, x2: 720, y2: 225, coords: 'screen', durationMs: 600, button: undefined, agentId: 'ag_1', signal: ctx.signal, caller: { key: 'ag_1', id: 'ag_1', name: 'Mira' }, motion: undefined });
  await drag.run({ from: { ref: 'e2', x: 0 }, by: { dx: 120, dy: 0 } }, ctx);
  assert.deepEqual([drags.at(-1)?.x1, drags.at(-1)?.x2, drags.at(-1)?.y2], [600, 720, 225]);
  await drag.run({ x1: 1, y1: 2, x2: 3, y2: 4 }, ctx);
  assert.deepEqual([drags.at(-1)?.x1, drags.at(-1)?.y2, drags.at(-1)?.coords], [1, 4, undefined]);
  await assert.rejects(drag.run({ from: { ref: 'e1' } }, ctx), /either to/);
  await assert.rejects(drag.run({ from: { ref: 'e1' }, to: { ref: 'e2' }, by: { dx: 1, dy: 1 } }, ctx), /either to/);
  await assert.rejects(drag.run({ x1: 1, y1: 2 }, ctx), /coordinates/);
  assert.equal(drags.length, 3, 'refused drags never move the pointer');
  assert.match(drag.describe!({ from: { ref: 'e1' }, by: { dx: 5, dy: 0 } }, ctx).summary, /^Drag e1 by 5,0 px/);
  assert.equal(drag.describe!({ from: { ref: 'e1' }, to: { ref: 'e2' } }, ctx).reversible, false, 'a drag stays irreversible');

  await scroll.run({ dy: 3, at: { ref: 'e2', y: 0 } }, ctx);
  assert.deepEqual([scrolls.at(-1)?.x, scrolls.at(-1)?.y, scrolls.at(-1)?.dy, scrolls.at(-1)?.coords], [800, 210, 3, 'screen']);
  await assert.rejects(scroll.run({ dy: 1, at: { ref: 'e3' } }, ctx), /no position/);
});
