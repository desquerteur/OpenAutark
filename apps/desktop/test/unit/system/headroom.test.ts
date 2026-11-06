// B-078 T10 – heavy-turn admission from real headroom (system/headroom.ts) and the waiting note (agents/split-admit.ts):
// the owner's 8 GB Windows PC (0.9–1.0 GB available, ~7 GB commit free) carries several turns at once instead of one;
// a genuinely starved PC still holds back to one; the bounds by cores and total RAM hold; Electron's memory info is
// read per platform and its absence falls back to node:os; "waiting for capacity" shows only while a turn really waits.
// Owns: these assertions only. Never: real processes or the real memory of this PC.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heavySlotsFor, readMemory, MIN_SLOTS } from '../../../src/runtime/system/headroom.ts';
import { Supervisor } from '../../../src/runtime/system/supervisor.ts';
import { admitAttempt, WAITING_NOTE } from '../../../src/runtime/agents/split-admit.ts';
import type { Engine } from '../../../src/runtime/engines/types.ts';
import type { Account } from '../../../src/shared/model/providers.ts';

const KB = 1024;

test("the owner's PC (8 GB, 8 cores, ~1 GB available, ~7 GB commit free) gets five heavy slots, not one", () => {
  // Measured 06.11.2026: 7916 MB total, 1038 MB free physical, 7054 MB commit free (limit 23351 MB).
  assert.equal(heavySlotsFor({ availableMb: 1038, totalMb: 7916, commitFreeMb: 7054, exact: true }, 8), 5);
  // Busier moment from the brief: 0.9 GB available, 6.9 GB commit free.
  assert.equal(heavySlotsFor({ availableMb: 900, totalMb: 7916, commitFreeMb: 6900, exact: true }, 8), 5);
  // Four CLIs already running (≈ 0.7 GB more commit, physical down to 0.4 GB): still the full five.
  assert.equal(heavySlotsFor({ availableMb: 400, totalMb: 7916, commitFreeMb: 6200, exact: true }, 8), 5);
});

test('a genuinely starved PC holds back to one; a tight one keeps the floor of two', () => {
  assert.equal(heavySlotsFor({ availableMb: 250, totalMb: 7916, commitFreeMb: 900, exact: true }, 8), 1, 'commit nearly gone');
  assert.equal(heavySlotsFor({ availableMb: 300, totalMb: 16_000, exact: true }, 16), 1, 'Linux MemAvailable 300 MB');
  assert.equal(heavySlotsFor({ availableMb: 700, totalMb: 4096, commitFreeMb: 2500, exact: true }, 4), MIN_SLOTS, '4 GB laptop');
  assert.ok(heavySlotsFor({ availableMb: 250, totalMb: 7916, commitFreeMb: 900, exact: true }, 8) < heavySlotsFor({ availableMb: 1038, totalMb: 7916, commitFreeMb: 7054, exact: true }, 8));
});

test('the number of slots is bounded by cores − 2 and by total RAM (1.5 GB per slot)', () => {
  assert.equal(heavySlotsFor({ availableMb: 60_000, totalMb: 64_000, commitFreeMb: 120_000, exact: true }, 8), 6, 'cores bound');
  assert.equal(heavySlotsFor({ availableMb: 6000, totalMb: 16_000, commitFreeMb: 15_000, exact: true }, 16), 10, 'total RAM bound');
  assert.equal(heavySlotsFor({ availableMb: 6000, totalMb: 16_000, exact: true }, 2), MIN_SLOTS, 'two cores still two');
});

test('without trusted numbers (Windows physical only, macOS) the floor of two holds even on little free RAM', () => {
  assert.equal(heavySlotsFor({ availableMb: 105, totalMb: 7916, exact: false }, 8), MIN_SLOTS);
  const supervisor = new Supervisor({ os: { freemem: () => 105 * KB * KB, cpuCount: () => 8, setPriority: () => {}, platform: 'win32' } });
  assert.equal(supervisor.maxHeavy(), MIN_SLOTS, 'the old formula gave 1 here');
});

test("readMemory takes Electron's numbers per platform and falls back to node:os", () => {
  const os = { freemem: () => 512 * KB * KB, totalmem: () => 8192 * KB * KB };
  const win = readMemory('win32', () => ({ total: 7916 * KB, free: 1038 * KB, swapTotal: 23351 * KB, swapFree: 7054 * KB }), os);
  assert.deepEqual(win, { availableMb: 1038, totalMb: 7916, commitFreeMb: 7054, exact: true });
  const linux = readMemory('linux', () => ({ total: 16_000 * KB, free: 200 * KB, available: 6000 * KB, swapFree: 0 }), os);
  assert.deepEqual(linux, { availableMb: 6000, totalMb: 16_000, exact: true });
  const mac = readMemory('darwin', () => ({ total: 16_384 * KB, free: 300 * KB, purgeable: 700 * KB }), os);
  assert.deepEqual(mac, { availableMb: 1000, totalMb: 16_384, exact: false });
  assert.deepEqual(readMemory('win32', undefined, os), { availableMb: 512, totalMb: 8192, exact: false });
  assert.deepEqual(readMemory('win32', () => { throw new Error('no'); }, os), { availableMb: 512, totalMb: 8192, exact: false });
  assert.deepEqual(readMemory('win32', () => ({ total: 7916 * KB, free: 1038 * KB }), os), { availableMb: 1038, totalMb: 7916, exact: false }, 'no commit numbers');
});

test('the supervisor reads its memory snapshot when the OS seam gives one', () => {
  const supervisor = new Supervisor({ os: {
    freemem: () => 0, cpuCount: () => 8, setPriority: () => {}, platform: 'win32',
    memory: () => ({ availableMb: 1038, totalMb: 7916, commitFreeMb: 7054, exact: true }),
  } });
  assert.equal(supervisor.maxHeavy(), 5);
});

const cli = { id: 'claude', caps: { ownTools: true } } as unknown as Engine;
const account = { id: 'acc_1' } as unknown as Account;
const log = { log: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } } as unknown as Parameters<typeof admitAttempt>[0];

test('"waiting for capacity" shows only while a turn really waits for its slot', async () => {
  const notes: string[] = [];
  const signal = new AbortController().signal;
  const free = await admitAttempt(log, {}, { engine: cli, account }, { admit: async () => () => {}, signal, runId: 'r1' }, (note) => notes.push(note));
  assert.equal(typeof free, 'function');
  assert.equal(notes.length, 0, 'a free slot: no waiting note');

  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const waiting = admitAttempt(log, {}, { engine: cli, account }, { admit: async () => { await gate; return () => {}; }, signal, runId: 'r2' }, (note) => notes.push(note));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notes, [WAITING_NOTE], 'a full PC: the note while it waits');
  open();
  assert.equal(typeof await waiting, 'function');
});

test('the supervisor admits at once while a slot is free (no waiting note) and the turn waits when full', async () => {
  const supervisor = new Supervisor({ os: { freemem: () => 0, cpuCount: () => 8, setPriority: () => {}, platform: 'linux' } });
  const notes: string[] = [];
  const signal = new AbortController().signal;
  const admit = (s: AbortSignal) => supervisor.admit(s);
  const first = await admitAttempt(log, {}, { engine: cli, account }, { admit, signal, runId: 'a' }, (note) => notes.push(note));
  assert.equal(notes.length, 0);
  const second = admitAttempt(log, {}, { engine: cli, account }, { admit, signal, runId: 'b' }, (note) => notes.push(note));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notes, [WAITING_NOTE]);
  first?.();
  (await second)?.();
});
