// F07 unsent takes in IndexedDB (pwa/idb.ts) against a small in-memory IndexedDB: a saved take
// comes back for "Resume unsent recording", dropping it removes it, takes older than a week are
// swept on the next save or load and by sweepTakes (other keys such as the offline To-do
// snapshot stay), a take above the size cap is not copied, and writes run in order so a quick
// Retake never races the save before it. recordTake (recorder.ts) with a fake MediaRecorder: a
// widget that leaves mid-recording still stores the take (and a mount right after waits for it),
// a discard mid-take stores nothing, and a take counts from the recorder's late 'start' event.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RecorderLike } from '../../../src/ui/blocks/ui/recorder.ts';

type Callback = (() => void) | undefined;
interface Request { result?: unknown; onsuccess?: Callback; onerror?: Callback; onupgradeneeded?: Callback }
const data = new Map<string, unknown>();
let created = false;
const later = (fn: () => void) => setTimeout(fn, 0);

function objectStore(track: { pending: number; done: () => void }) {
  return {
    get(key: string) { const req: Request = {}; later(() => { req.result = data.get(key); req.onsuccess?.(); }); return req; },
    put(value: unknown, key: string) { data.set(key, value); },
    delete(key: string) { data.delete(key); },
    openCursor(range: { lower: string; upper: string }) {
      const req: Request = {};
      const keys = [...data.keys()].filter((key) => key >= range.lower && key <= range.upper).sort();
      let index = 0;
      track.pending++;
      const step = () => later(() => {
        const key = keys[index++];
        if (key === undefined) { req.result = null; req.onsuccess?.(); track.pending--; track.done(); return; }
        req.result = { value: data.get(key), delete: () => data.delete(key), continue: step };
        req.onsuccess?.();
      });
      step();
      return req;
    },
  };
}

const fakeDb = {
  createObjectStore() { created = true; },
  close() {},
  transaction() {
    const tx: { oncomplete?: Callback; objectStore?: unknown } = {};
    const track = { pending: 0, done: () => later(() => { if (track.pending === 0) tx.oncomplete?.(); }) };
    tx.objectStore = () => objectStore(track);
    track.done();
    return tx;
  },
};

Object.assign(globalThis, {
  IDBKeyRange: { bound: (lower: string, upper: string) => ({ lower, upper }) },
  indexedDB: {
    open() {
      const req: Request = {};
      later(() => { req.result = fakeDb; if (!created) req.onupgradeneeded?.(); req.onsuccess?.(); });
      return req;
    },
  },
});

const { TAKE_MAX_AGE_MS, TAKE_MAX_BYTES, TODO_SNAPSHOT_KEY, dropTake, idbSet, loadTake, saveTake, sweepTakes } = await import('../../../src/ui/pwa/idb.ts');
const { endUnsaved, leftMidTake, recordTake, unsentTake } = await import('../../../src/ui/blocks/ui/recorder.ts');

const take = (text: string, at = Date.now()) => ({ blob: new Blob([text], { type: 'audio/webm' }), mime: 'audio/webm', seconds: 3, at });

/** A started MediaRecorder: stop() hands over the last chunk, then 'stop' fires – both later, as in browsers. */
function fakeRecorder(tail = 'tail') {
  const recorder = {
    state: 'recording',
    mimeType: 'video/webm',
    ondataavailable: null as ((event: { data: Blob }) => void) | null,
    onstop: null as (() => void) | null,
    stop() {
      if (recorder.state === 'inactive') return;
      recorder.state = 'inactive';
      later(() => { recorder.ondataavailable?.({ data: new Blob([tail]) }); later(() => recorder.onstop?.()); });
    },
    chunk(text: string) { recorder.ondataavailable?.({ data: new Blob([text]) }); },
  };
  return recorder;
}
const asRecorder = (recorder: ReturnType<typeof fakeRecorder>) => recorder as unknown as RecorderLike;

/** recordTake on a fake recorder; `ended` resolves with what onEnd got. */
function recording(key: string, options: { tail?: string; now?: () => number } = {}) {
  const recorder = fakeRecorder(options.tail);
  const ended = new Promise<{ blob: Blob; seconds: number }>((resolve) => {
    recordTake(asRecorder(recorder), { key, type: 'video/webm', now: options.now, onEnd: (blob, _mime, seconds) => resolve({ blob, seconds }) });
  });
  return { recorder, ended };
}

test('a saved take comes back for "Resume unsent recording" until it is dropped', async () => {
  await saveTake('task_1', take('hello'));
  const stored = await loadTake('task_1');
  assert.ok(stored, 'kept under the widget key');
  assert.equal(await stored.blob.text(), 'hello');
  assert.equal(stored.mime, 'audio/webm');
  assert.equal(stored.seconds, 3);
  assert.ok(data.has('take:task_1'), 'stored with the take prefix');
  await dropTake('task_1');
  assert.equal(await loadTake('task_1'), undefined);
  assert.equal(await loadTake('task_unknown'), undefined);
});

test('takes older than a week are swept; other entries stay', async () => {
  await idbSet(TODO_SNAPSHOT_KEY, { at: 0, items: [] });
  data.set('take:old', take('old', Date.now() - TAKE_MAX_AGE_MS - 1000));
  await saveTake('task_2', take('fresh'));
  assert.ok(!data.has('take:old'), 'the week-old take is gone');
  assert.ok(data.has('take:task_2'));
  assert.ok(data.has(TODO_SNAPSHOT_KEY), 'the offline snapshot is not a take');
  data.set('take:old2', take('old', Date.now() - TAKE_MAX_AGE_MS - 1000));
  assert.equal(await loadTake('old2'), undefined, 'a stale take is never offered');
  await dropTake('task_2');
});

test('a save followed at once by a drop ends dropped (writes run in order)', async () => {
  const saving = saveTake('task_3', take('first'));
  const dropping = dropTake('task_3');
  await Promise.all([saving, dropping]);
  assert.equal(await loadTake('task_3'), undefined);
  void saveTake('task_4', take('a'));
  await saveTake('task_4', take('b'));
  assert.equal(await (await loadTake('task_4'))!.blob.text(), 'b', 'the later take wins');
});

test('an empty blob is not offered', async () => {
  await saveTake('task_5', { blob: new Blob([]), mime: 'video/webm', seconds: 0, at: Date.now() });
  assert.equal(await loadTake('task_5'), undefined);
});

test('a take above the size cap is not copied and leaves no older take behind', async () => {
  await saveTake('task_6', take('small'));
  await saveTake('task_6', { blob: { size: TAKE_MAX_BYTES + 1 } as Blob, mime: 'video/mp4', seconds: 3600, at: Date.now() });
  assert.ok(!data.has('take:task_6'), 'nothing is written for it, and the older take under that key is gone');
});

test('sweepTakes removes week-old takes whose widget never mounts again', async () => {
  await idbSet(TODO_SNAPSHOT_KEY, { at: 0, items: [] });
  data.set('take:answered-elsewhere', take('old', Date.now() - TAKE_MAX_AGE_MS - 1000));
  data.set('take:fresh', take('fresh'));
  await sweepTakes();
  assert.ok(!data.has('take:answered-elsewhere'));
  assert.ok(data.has('take:fresh') && data.has(TODO_SNAPSHOT_KEY));
  await dropTake('fresh');
});

// ------------------------------------------------------------------ recordTake (recorder.ts)

test('a widget that leaves mid-recording still stores the take for "Resume unsent recording"', async () => {
  let clock = Date.now() - 42_000; // started 42 s ago
  const { recorder, ended } = recording('task_r1', { now: () => clock });
  recorder.chunk('first part ');
  clock += 42_000;
  recorder.stop(); // the widget unmounted: its cleanup stops the recorder (and ignores onEnd)
  const end = await ended;
  assert.equal(end.seconds, 42);
  const stored = await loadTake('task_r1');
  assert.ok(stored, 'kept under the widget key');
  assert.equal(await stored.blob.text(), 'first part tail', 'every chunk up to the stop, the last one included');
  assert.equal(stored.mime, 'video/webm');
  assert.equal(stored.seconds, 42, 'offered as "Unsent recording · 0:42"');
  await dropTake('task_r1');
});

test("a take counts from the recorder's 'start' event (or its first data where none fires)", async () => {
  let clock = Date.now() - 10_000;
  let starts = 0;
  const recorder = fakeRecorder();
  const ended = new Promise<number>((resolve) => {
    recordTake(asRecorder(recorder), { key: 'task_r5', type: 'video/webm', now: () => clock, onStart: () => { starts++; }, onEnd: (_blob, _mime, seconds) => resolve(seconds) });
  });
  assert.equal(starts, 0, 'Record was clicked, the encoder is still starting: "Starting…"');
  clock += 2_000;
  asRecorder(recorder).onstart?.(new Event('start'));
  recorder.chunk('first part ');
  assert.equal(starts, 1, 'once, at the start event');
  clock += 3_000;
  recorder.stop();
  assert.equal(await ended, 3, 'the two seconds before the start are not part of the take');
  assert.equal(starts, 1);
  await dropTake('task_r5');

  let fallbackStarts = 0;
  const quiet = fakeRecorder(); // no 'start' event: the first data starts it
  const stored = recordTake(asRecorder(quiet), { key: 'task_r6', type: 'video/webm', onStart: () => { fallbackStarts++; }, onEnd: () => undefined });
  quiet.chunk('');
  assert.equal(fallbackStarts, 0, 'an empty chunk is no data');
  quiet.chunk('data');
  quiet.chunk('more');
  assert.equal(fallbackStarts, 1);
  quiet.stop();
  await stored;
  await dropTake('task_r6');
});

test('"Discard recording?" mid-take stops the recorder and stores nothing', async () => {
  let ended = false;
  const recorder = fakeRecorder();
  recordTake(asRecorder(recorder), { key: 'task_r2', type: 'video/webm', onEnd: () => { ended = true; } });
  recorder.chunk('half a take');
  endUnsaved(asRecorder(recorder));
  assert.equal(recorder.state, 'inactive', 'the camera/microphone is let go');
  await new Promise((resolve) => setTimeout(resolve, 20)); // the recorder's late chunk and stop event
  assert.equal(ended, false, 'no take comes back to the widget');
  assert.equal(await loadTake('task_r2'), undefined, 'and none is stored');
  assert.doesNotThrow(() => endUnsaved(asRecorder(recorder)), 'a stopped recorder is left alone');
});

test('Retake drops the stored take before the new one is recorded', async () => {
  const first = recording('task_r3');
  first.recorder.chunk('take one ');
  first.recorder.stop();
  await first.ended; // its save is queued
  void dropTake('task_r3'); // Retake: the take and its stored copy go, then a fresh preview
  assert.equal(await loadTake('task_r3'), undefined, 'nothing to resume between the takes');
  const second = recording('task_r3');
  second.recorder.chunk('take two ');
  second.recorder.stop();
  await second.ended;
  assert.equal(await (await loadTake('task_r3'))!.blob.text(), 'take two tail', 'only the new take is kept');
  await dropTake('task_r3');
});

test('an empty recording is handed back but not stored', async () => {
  const { recorder, ended } = recording('task_r4', { tail: '' });
  recorder.stop();
  assert.equal((await ended).blob.size, 0, 'the widget says "Nothing was recorded."');
  assert.equal(await loadTake('task_r4'), undefined);
  assert.ok(!data.has('take:task_r4'));
});

test('a widget mounted right after leaving mid-recording waits for that take to be stored', async () => {
  const recorder = fakeRecorder();
  const stored = recordTake(asRecorder(recorder), { key: 'task_r5', type: 'video/webm', onEnd: () => undefined });
  recorder.chunk('left mid-take ');
  leftMidTake('task_r5', stored); // the old widget's cleanup, before it stops the recorder
  recorder.stop(); // its last chunk and 'stop' come later, as in browsers
  const offered = await unsentTake('task_r5'); // the new widget mounts at once
  assert.ok(offered, '"Resume unsent recording" is offered on this mount, not only the next');
  assert.equal(await offered.blob.text(), 'left mid-take tail');
  await dropTake('task_r5');
  assert.equal(await unsentTake('task_r5'), undefined, 'nothing is left once dropped');
});
