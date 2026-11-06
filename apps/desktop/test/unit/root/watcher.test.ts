// B-044: the data folder watcher (runtime/root/watcher.ts) on a temp folder –
// - one recursive watch on <data> (`recursive: true`, the mode of Windows and macOS – the other one is in
//   watcher-folders.test.ts); events go by their first segment to the registered owner; app-managed
//   entries, entries without an owner, temporary files and rejected copies are dropped; one owner per entry;
// - per-path debounce (one hand-over per path, at the latest after MAX_WAIT) and nudges through it;
// - the app's own writes (wrote(): size + hash) that still hold exactly that content are not handed over,
//   an outside edit of the same size is; a nudge always is;
// - no file name → every owner checks everything; after an error the watcher is armed again on the next use
//   (not before REARM_MS, the folder created again), and every owner checks once;
// - with the real fs.watch (this system's default mode): an edit below an owned folder arrives, the app's own
//   atomic write does not, and a removed and recreated owner folder is still watched.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, rmSync, writeFileSync, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { RootWatcher, REARM_MS, type RootEvent, type WatchFn } from '../../../src/runtime/root/watcher.ts';
import { writeAtomic } from '../../../src/runtime/root/text-doc.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { clock, tempDir } from '../store/helpers.ts';

function fakeWatch(): { watch: WatchFn; fire: (name: string | null) => void; fail: () => void; targets: string[] } {
  let listener: ((event: string, name: string | Buffer | null) => void) | undefined;
  let current: EventEmitter | undefined;
  const targets: string[] = [];
  const watch: WatchFn = (target, options, onEvent) => {
    assert.equal(options.recursive, true);
    targets.push(target);
    listener = onEvent;
    current = Object.assign(new EventEmitter(), { close: () => { listener = undefined; } });
    return current as unknown as FSWatcher;
  };
  return { watch, targets, fire: (name) => listener?.('change', name), fail: () => current?.emit('error', new Error('EPERM: the folder went away')) };
}

function setup(options: { debounceMs?: number; maxWaitMs?: number } = {}) {
  const temp = tempDir('wf-root-');
  const data = path.join(temp.dir, 'data');
  mkdirSync(data, { recursive: true });
  const fake = fakeWatch();
  const time = clock();
  const log = new MemoryLogger();
  const root = new RootWatcher({ root: data, clock: time, log, watch: fake.watch, debounceMs: options.debounceMs ?? 1, maxWaitMs: options.maxWaitMs, recursive: true });
  const heard: Record<string, Array<string | undefined>> = {};
  const own = (name: string) => {
    heard[name] = [];
    return root.register(name, (event: RootEvent) => { heard[name]!.push(event.parts?.join('/')); });
  };
  root.start();
  return { temp, data, fake, time, log, root, heard, own, cleanup: () => { root.stop(); temp.cleanup(); } };
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

test('dispatch by first segment: owned entries only, never temporary files, rejected copies or app-managed entries', () => {
  const t = setup();
  try {
    assert.deepEqual(t.fake.targets, [t.data], 'ONE recursive watch on the data folder');
    t.own('agents');
    t.own('settings.json');
    t.fake.fire(`agents${path.sep}ag_1${path.sep}SYSTEM.md`);
    t.fake.fire('agents/ag_1/SYSTEM.md.4711.tmp');
    t.fake.fire('agents/ag_1/SYSTEM.rejected.md');
    t.fake.fire('settings.json');
    t.fake.fire('settings.json.12.tmp');
    t.fake.fire('settings.rejected.json');
    t.fake.fire('workforce.db-wal');
    t.fake.fire('blobs/ab/cd/123');
    t.fake.fire('GPUCache/data_1');
    t.fake.fire('agents');
    t.root.flush();
    assert.deepEqual(t.heard.agents, ['ag_1/SYSTEM.md', '']);
    assert.deepEqual(t.heard['settings.json'], ['']);
    assert.throws(() => t.root.register('blobs', () => {}), /app-managed/);
    assert.throws(() => t.root.register('agents', () => {}), /already has an owner/);
    assert.throws(() => t.root.register('agents/x', () => {}), /Not an entry/);
  } finally { t.cleanup(); }
});

test('unregister: the entry is no longer handed over and may get a new owner', () => {
  const t = setup();
  try {
    const off = t.own('prompts');
    t.fake.fire('prompts/identity.md');
    off();
    t.root.flush();
    assert.deepEqual(t.heard.prompts, [], 'what was queued goes with the owner');
    t.own('prompts');
    t.fake.fire('prompts/identity.md');
    t.root.flush('prompts');
    assert.deepEqual(t.heard.prompts, ['identity.md']);
  } finally { t.cleanup(); }
});

test('debounce per path: repeated events hand a path over once, other paths separately', async () => {
  const t = setup({ debounceMs: 20 });
  try {
    t.own('modes');
    for (let i = 0; i < 5; i++) t.fake.fire('modes/writing.md');
    t.fake.fire('modes/coding.md');
    await sleep(80);
    assert.deepEqual([...t.heard.modes!].sort(), ['coding.md', 'writing.md']);
  } finally { t.cleanup(); }
});

test('debounce: a path that keeps changing is handed over at the latest after the maximum wait', async () => {
  const t = setup({ debounceMs: 40, maxWaitMs: 60 });
  try {
    t.own('modes');
    const started = Date.now();
    while (Date.now() - started < 150 && t.heard.modes!.length === 0) {
      t.fake.fire('modes/writing.md');
      await sleep(10);
    }
    assert.deepEqual(t.heard.modes, ['writing.md'], 'not starved by a steady stream of events');
  } finally { t.cleanup(); }
});

test('own writes: a path that still holds what the app wrote is no outside edit; an edit of the same size is', () => {
  const t = setup();
  try {
    t.own('agents');
    const file = path.join(t.data, 'agents', 'ag_1', 'SYSTEM.md');
    writeAtomic(file, 'Before.\n', t.root);
    t.fake.fire('agents/ag_1/SYSTEM.md');
    t.root.flush();
    assert.deepEqual(t.heard.agents, [], 'the own write is dropped');
    t.fake.fire('agents/ag_1/SYSTEM.md'); // a second event of the same write
    t.root.flush();
    assert.deepEqual(t.heard.agents, []);

    writeFileSync(file, 'Edited.\n'); // same size, other content
    t.fake.fire('agents/ag_1/SYSTEM.md');
    t.root.flush();
    assert.deepEqual(t.heard.agents, ['ag_1/SYSTEM.md']);
    writeFileSync(file, 'Before.\n'); // back to the old text: the mark went with the outside edit
    t.fake.fire('agents/ag_1/SYSTEM.md');
    t.root.flush();
    assert.deepEqual(t.heard.agents, ['ag_1/SYSTEM.md', 'ag_1/SYSTEM.md']);

    t.root.wrote(file, 'Before.\n');
    t.root.nudge('agents', ['ag_1', 'SYSTEM.md']);
    t.root.flush();
    assert.equal(t.heard.agents!.length, 3, 'a nudge is always handed over');

    rmSync(file);
    t.root.wrote(file, null);
    t.fake.fire('agents/ag_1/SYSTEM.md');
    t.root.flush();
    assert.equal(t.heard.agents!.length, 3, 'the own removal is dropped');
    t.root.wrote(path.join(t.temp.dir, 'elsewhere.md'), 'x'); // outside the data folder: ignored
  } finally { t.cleanup(); }
});

test('no file name: every owner checks everything once', () => {
  const t = setup();
  try {
    t.own('agents');
    t.own('settings.json');
    t.fake.fire(null);
    t.fake.fire(null);
    t.root.flush();
    assert.deepEqual(t.heard.agents, [undefined]);
    assert.deepEqual(t.heard['settings.json'], [undefined]);
  } finally { t.cleanup(); }
});

test('after an error: armed again on the next use, not before REARM_MS, the folder created again; every owner checks once', () => {
  const t = setup();
  try {
    t.own('agents');
    t.fake.fail();
    assert.equal(t.root.active, false);
    assert.ok(t.log.entries.some((entry) => entry.message === 'data folder watcher stopped'));
    t.root.ensure();
    assert.equal(t.fake.targets.length, 1, 'not before REARM_MS');
    rmSync(t.data, { recursive: true, force: true });
    t.time.advance(REARM_MS + 1);
    t.root.ensure();
    assert.equal(t.fake.targets.length, 2, 'armed again');
    assert.ok(existsSync(t.data), 'the data folder exists again');
    assert.equal(t.root.active, true);
    t.root.flush();
    assert.deepEqual(t.heard.agents, [undefined], 'what changed meanwhile: checked once');
    t.root.ensure();
    assert.equal(t.fake.targets.length, 2, 'a running watcher is left alone');
    t.root.stop();
    t.time.advance(REARM_MS + 1);
    t.root.ensure();
    assert.equal(t.fake.targets.length, 2, 'stopped stays stopped');
  } finally { t.cleanup(); }
});

test('a refused start is tried again on the next use; without a watch, nudges still go through the debounce', () => {
  const temp = tempDir('wf-root-');
  try {
    const time = clock();
    let calls = 0;
    const refusing: WatchFn = (...args) => { calls++; if (calls === 1) throw new Error('ENOSPC'); return fakeWatch().watch(...args); };
    const root = new RootWatcher({ root: temp.dir, clock: time, watch: refusing, debounceMs: 1, recursive: true });
    assert.equal(root.start(), false);
    time.advance(REARM_MS + 1);
    root.ensure();
    assert.equal(root.active, true);
    root.stop();

    const quiet = new RootWatcher({ root: temp.dir, clock: time, watch: false, debounceMs: 1 });
    const heard: Array<string | undefined> = [];
    quiet.register('agents', (event) => { heard.push(event.parts?.join('/')); });
    assert.equal(quiet.start(), false);
    quiet.nudge('agents', ['ag_1', 'SYSTEM.md']);
    quiet.nudge('custom');
    quiet.flush();
    assert.deepEqual(heard, ['ag_1/SYSTEM.md']);
    quiet.stop();
  } finally { temp.cleanup(); }
});

test('real fs.watch: an outside edit below an owned folder arrives, the own atomic write does not, a recreated folder is still watched', async () => {
  const temp = tempDir('wf-root-real-');
  const root = new RootWatcher({ root: temp.dir, clock: clock(), log: new MemoryLogger(), debounceMs: 30 });
  try {
    const heard: string[] = [];
    root.register('agents', (event) => { heard.push(event.parts?.join('/') ?? '*'); });
    assert.equal(root.start(), true);
    const dir = path.join(temp.dir, 'agents', 'ag_1');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'SYSTEM.md');
    const arrives = async (rel: string) => {
      for (let waited = 0; waited < 4000 && !heard.includes(rel) && !heard.includes('*'); waited += 25) await sleep(25);
      return heard.includes(rel) || heard.includes('*');
    };

    writeAtomic(file, 'Own text.\n', root);
    await sleep(400);
    assert.ok(!heard.includes('ag_1/SYSTEM.md'), `the own write is no outside edit: ${heard.join(', ')}`);

    writeFileSync(file, 'Edited in an editor.\n');
    assert.ok(await arrives('ag_1/SYSTEM.md'), `the edit arrives: ${heard.join(', ')}`);

    rmSync(path.join(temp.dir, 'agents'), { recursive: true, force: true });
    await sleep(100);
    heard.length = 0;
    mkdirSync(dir, { recursive: true });
    await sleep(200); // a folder with a watch of its own (no native tree watch) is armed again once <data>'s watch names it
    writeFileSync(file, 'Written again.\n');
    assert.ok(await arrives('ag_1/SYSTEM.md'), `the recreated folder is watched: ${heard.join(', ')}`);
  } finally {
    root.stop();
    temp.cleanup();
  }
});
