// MM9: system.resources reports the runtime process itself (compose/network.ts runtimeUsage):
// memory (rss, heap), CPU time and the CPU share of one core since the previous read, and the
// resident knowledge vector index (worker threads, vector memory).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeUsage } from '../../../src/runtime/compose/network.ts';

test('runtime usage: memory, CPU share since the previous read and the vector index', () => {
  const mark = { cpuMs: 0, uptimeMs: 0 };
  const first = runtimeUsage(mark, { workers: 1, bytes: 5 * 1024 * 1024 });
  assert.equal(first.pid, process.pid);
  assert.ok(first.rssMb > 0 && first.heapUsedMb > 0 && first.rssMb >= first.heapUsedMb, JSON.stringify(first));
  assert.ok(first.cpuMs > 0 && first.uptimeMs > 0);
  assert.deepEqual([first.vectorWorkers, first.vectorIndexMb], [1, 5]);
  assert.ok(mark.cpuMs > 0 && mark.uptimeMs > 0, 'the read is the next mark');

  const until = Date.now() + 60;
  let spin = 0;
  while (Date.now() < until) spin++; // busy for 60 ms
  const busy = runtimeUsage(mark, { workers: 0, bytes: 0 });
  assert.ok(spin > 0 && busy.cpuPercent > 40 && busy.cpuPercent <= 400, `a busy window shows CPU (${busy.cpuPercent} %)`);
  assert.deepEqual([busy.vectorWorkers, busy.vectorIndexMb], [0, 0], 'after the idle unload');
  assert.ok(busy.cpuMs >= first.cpuMs);
});
