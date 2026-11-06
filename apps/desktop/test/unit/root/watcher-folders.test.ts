// B-044: the data folder watcher (runtime/root/watcher.ts) where the system has no native tree watch (Linux: Node
// would walk all of <data> and watch every file in it) – forced with `recursive: false`, so it runs on every system:
// - <data> itself plus one recursive watch per owned folder; a file entry or a folder not there yet has none;
// - events are named below <data> as by the one tree watch; nothing is named while a handle is created;
// - a folder's watch follows it (armed when it comes, closed when it goes or its owner leaves); a folder handle's
//   error stops the watcher, which is armed again with its folders;
// - with the real fs.watch: an edit in an owned folder and in a file entry arrive, the app's own write does not.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { RootWatcher, REARM_MS, type WatchFn } from '../../../src/runtime/root/watcher.ts';
import { writeAtomic } from '../../../src/runtime/root/text-doc.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { clock, tempDir } from '../store/helpers.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** A fake fs.watch with one handle per call; like Node's own tree walk, each names a file while it is created. */
function fakeHandles() {
  const handles: Array<{ target: string; recursive: boolean; closed: boolean; fire: (name: string | null) => void; fail: () => void }> = [];
  const watch: WatchFn = (target, options, onEvent) => {
    const emitter = new EventEmitter();
    const handle = {
      target, recursive: options.recursive, closed: false,
      fire: (name: string | null) => { if (!handle.closed) onEvent('change', name); },
      fail: () => { emitter.emit('error', new Error('ENOSPC: no more watches')); },
    };
    handles.push(handle);
    onEvent('rename', `already-there${path.sep}SYSTEM.md`);
    return Object.assign(emitter, { close: () => { handle.closed = true; } }) as unknown as FSWatcher;
  };
  const open = () => handles.filter((handle) => !handle.closed).map((handle) => `${path.basename(handle.target)}${handle.recursive ? ' (recursive)' : ''}`);
  const last = (name: string) => [...handles].reverse().find((handle) => path.basename(handle.target) === name)!;
  return { watch, open, last };
}

test('without a native tree watch: <data> itself plus one recursive watch per owned folder, following the folder', () => {
  const temp = tempDir('wf-root-');
  const data = path.join(temp.dir, 'data');
  mkdirSync(path.join(data, 'agents'), { recursive: true });
  writeFileSync(path.join(data, 'settings.json'), '{}\n');
  const time = clock();
  const fake = fakeHandles();
  const root = new RootWatcher({ root: data, clock: time, log: new MemoryLogger(), watch: fake.watch, debounceMs: 1, recursive: false });
  const heard: string[] = [];
  const own = (name: string) => root.register(name, (event) => { heard.push(`${name}:${event.parts?.join('/') ?? '*'}`); });
  try {
    own('agents');
    assert.equal(root.start(), true);
    own('settings.json');
    const offSecrets = own('secrets'); // not there yet
    assert.deepEqual(fake.open(), ['data', 'agents (recursive)'], 'no walk of <data>; a file entry or a missing folder has no handle');
    fake.last('agents').fire(`ag_1${path.sep}SYSTEM.md`);
    fake.last('data').fire('settings.json');
    fake.last('data').fire('GPUCache');
    root.flush();
    assert.deepEqual(heard.sort(), ['agents:ag_1/SYSTEM.md', 'settings.json:'], 'named below <data> as by the one tree watch; nothing named while a handle was created');

    heard.length = 0;
    mkdirSync(path.join(data, 'secrets'));
    fake.last('data').fire('secrets'); // the folder came
    rmSync(path.join(data, 'agents'), { recursive: true });
    fake.last('data').fire('agents'); // the folder went
    assert.deepEqual(fake.open(), ['data', 'secrets (recursive)']);
    root.flush();
    assert.deepEqual(heard.sort(), ['agents:', 'secrets:'], 'the owner hears that its entry itself changed');
    mkdirSync(path.join(data, 'agents'));
    fake.last('data').fire('agents');
    assert.deepEqual(fake.open(), ['data', 'secrets (recursive)', 'agents (recursive)'], 'a recreated folder is watched again');
    offSecrets();
    assert.deepEqual(fake.open(), ['data', 'agents (recursive)'], 'an owner that leaves takes its handle along');

    fake.last('agents').fail();
    assert.equal(root.active, false, "a folder handle's error stops the watcher");
    assert.deepEqual(fake.open(), []);
    time.advance(REARM_MS + 1);
    root.ensure();
    assert.deepEqual(fake.open(), ['data', 'agents (recursive)'], 'armed again with its folders');
  } finally {
    root.stop();
    temp.cleanup();
  }
});

test('real fs.watch without the one tree watch: an edit in an owned folder and in a file entry arrive, the own write does not', async () => {
  const temp = tempDir('wf-root-real-');
  const root = new RootWatcher({ root: temp.dir, clock: clock(), log: new MemoryLogger(), debounceMs: 30, recursive: false });
  try {
    const heard: string[] = [];
    mkdirSync(path.join(temp.dir, 'agents', 'ag_1'), { recursive: true });
    root.register('agents', (event) => { heard.push(`agents:${event.parts?.join('/') ?? '*'}`); });
    root.register('settings.json', (event) => { heard.push(`settings.json:${event.parts?.join('/') ?? '*'}`); });
    assert.equal(root.start(), true);
    const file = path.join(temp.dir, 'agents', 'ag_1', 'SYSTEM.md');
    writeAtomic(file, 'Own text.\n', root);
    await sleep(400);
    assert.ok(!heard.includes('agents:ag_1/SYSTEM.md'), `the own write is no outside edit: ${heard.join(', ')}`);
    writeFileSync(file, 'Edited in an editor.\n');
    writeFileSync(path.join(temp.dir, 'settings.json'), '{ "voice": {} }\n');
    const wanted = ['agents:ag_1/SYSTEM.md', 'settings.json:'];
    for (let waited = 0; waited < 4000 && !wanted.every((name) => heard.includes(name)); waited += 25) await sleep(25);
    assert.ok(wanted.every((name) => heard.includes(name)), `both arrive: ${heard.join(', ')}`);
  } finally {
    root.stop();
    temp.cleanup();
  }
});
