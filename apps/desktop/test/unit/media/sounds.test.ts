// B-058 G9 (media/sounds.ts): the window plan (cells tile the samples, ≤ MAX_WINDOWS, no window under
// 1 s – CED aborts the process on very short input), the label → span merge (threshold, a window's weak
// top label, one-cell gaps bridged, strongest first), the texts and SoundTagger's
// residency with a fake addon: download once, padded windows, CPU budget (partial), stop, no refusal on low
// "free" memory (G4: a small model), load failure and the idle unload; the registry's download through
// ensureTagger (its voice.pull events) when the runtime has a bus.
// Owns: these tests. Never: loads the real model (sounds-live.test.ts does, when it is there).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { AUDIO_TAGGER } from '../../../src/shared/model/local-speech-models.ts';
import { modelDir } from '../../../src/runtime/voice/local/store.ts';
import { SMALL_MODEL_MB } from '../../../src/runtime/voice/local/engine.ts';
import { MAX_WINDOWS, mergeSounds, setSoundTagger, SoundTagger, soundTagger, soundsText, spanText, tagWindows, timeText, type SoundEvent, type TaggerAddon } from '../../../src/runtime/media/sounds.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { tempDir } from '../store/helpers.ts';
import { decodedSpan, fakeAddon, installFakeTagger, RATE, toneThenSilence } from './sounds-fixture.ts';

test('tagWindows: cells tile the samples, windows stay inside, are never under 1 s, and stay within MAX_WINDOWS', () => {
  for (const seconds of [0.3, 1, 2.5, 60, 300, 1200]) {
    const length = Math.round(seconds * RATE);
    const { hop, windows } = tagWindows(length);
    assert.ok(windows.length <= MAX_WINDOWS, `${seconds} s: ${windows.length} windows`);
    assert.equal(windows[0].cellFrom, 0);
    assert.equal(windows.at(-1)!.cellTo, length);
    for (let i = 1; i < windows.length; i++) assert.equal(windows[i].cellFrom, windows[i - 1].cellTo);
    for (const window of windows) {
      assert.ok(window.from >= 0 && window.to <= length && window.from <= window.cellFrom && window.to >= window.cellTo);
      assert.ok(window.to - window.from >= Math.min(length, RATE));
    }
    assert.ok(hop >= RATE);
  }
  assert.equal(tagWindows(60 * RATE).hop, RATE, 'a minute: one-second cells');
  assert.equal(tagWindows(60 * RATE).windows[10].to - tagWindows(60 * RATE).windows[10].from, 2 * RATE, 'with a second of context');
  assert.equal(tagWindows(300 * RATE).hop, 2 * RATE);
});

test('mergeSounds: labels over the threshold (and a weak top label) become spans; a one-cell gap is bridged; the strongest, in time order', () => {
  const cell = (second: number, events: SoundEvent[]) => ({ startMs: second * 1000, endMs: (second + 1) * 1000, events });
  const cells = [
    cell(0, [{ name: 'Music', prob: 0.82 }, { name: 'Speech', prob: 0.1 }]),
    cell(1, [{ name: 'Music', prob: 0.86 }, { name: 'Speech', prob: 0.55 }]),
    cell(2, [{ name: 'Speech', prob: 0.61 }, { name: 'Music', prob: 0.2 }]), // music dips for one cell
    cell(3, [{ name: 'Music', prob: 0.84 }, { name: 'Dog', prob: 0.31 }]),
    cell(4, [{ name: 'Beep, bleep', prob: 0.24 }, { name: 'Buzzer', prob: 0.21 }]), // nothing clear: the top label counts
    cell(5, [{ name: 'Music', prob: 0.8 }]),
    cell(8, [{ name: 'Music', prob: 0.81 }, { name: '', prob: 0.9 }, { name: 'Bad', prob: Number.NaN }]),
  ];
  const labels = mergeSounds(cells, 1000);
  assert.deepEqual(labels.map((entry) => entry.label), ['Music', 'Speech', 'Dog', 'Beep, bleep']);
  assert.deepEqual(labels[0], { label: 'Music', peak: 0.86, coveredMs: 5000, spans: [{ startMs: 0, endMs: 6000 }, { startMs: 8000, endMs: 9000 }] });
  assert.deepEqual(labels[1].spans, [{ startMs: 1000, endMs: 3000 }]);
  assert.deepEqual(soundsText(labels), ['Music 0:00–0:06, 0:08 (0.86)', 'Speech 0:01–0:03 (0.61)', 'Dog 0:03 (0.31)', 'Beep, bleep 0:04 (0.24)']);
  assert.equal(spanText({ startMs: 12_000, endMs: 13_000 }), '0:12');
  assert.equal(spanText({ startMs: 5_000, endMs: 42_000 }), '0:05–0:42');
  assert.deepEqual([0, 7_900, 720_000, 3_723_000].map(timeText), ['0:00', '0:07', '12:00', '1:02:03']);
  const many = Array.from({ length: 9 }, (_, i) => cell(i * 3, [{ name: 'Knock', prob: 0.5 }]));
  assert.equal(soundsText(mergeSounds(many, 1000))[0], 'Knock 0:00, 0:03, 0:06, 0:09, 0:12, 0:15 +3 more (0.50)');
});

test('SoundTagger: downloads once, pads short windows to 1 s, tags in file time and unloads when idle', async () => {
  const temp = tempDir();
  try {
    const log = new MemoryLogger();
    let installs = 0;
    const { addon, seen } = fakeAddon((index) => [{ name: index < 2 ? 'Speech' : 'Music', prob: 0.7 }]);
    let collected = 0;
    const tagger = new SoundTagger({
      dataDir: () => temp.dir, log, addon: () => addon, cpuCores: () => 8, freeMemoryMb: () => 4000, idleMs: 50, collect: () => { collected++; },
      install: async () => { installs++; await new Promise((resolve) => setImmediate(resolve)); installFakeTagger(temp.dir); },
    });
    assert.equal(tagger.installed(), false);
    await assert.rejects(tagger.tag(new Float32Array(RATE)), /not downloaded on this PC yet/);
    await Promise.all([tagger.ensure(), tagger.ensure()]);
    assert.equal(installs, 1, 'a second caller joins the running download');
    await tagger.ensure();
    assert.equal(installs, 1);

    const short = await tagger.tag(new Float32Array(Math.round(0.4 * RATE)), { startMs: 2_000 });
    assert.deepEqual(seen.lengths, [RATE], 'a 0.4 s recording is padded to one second');
    assert.deepEqual(short, { startMs: 2_000, endMs: 2_400, labels: [{ label: 'Speech', peak: 0.7, coveredMs: 400, spans: [{ startMs: 2_000, endMs: 2_400 }] }], partial: false });
    const config = seen.configs[0] as { model: { ced: string; numThreads: number; provider: string }; labels: string; topK: number };
    assert.equal(config.model.ced, path.join(modelDir(temp.dir, AUDIO_TAGGER), 'model.int8.onnx'));
    assert.equal(config.labels, path.join(modelDir(temp.dir, AUDIO_TAGGER), 'class_labels_indices.csv'));
    assert.deepEqual([config.model.numThreads, config.model.provider, config.topK], [4, 'cpu', 5]);

    const report = await tagger.tag(new Float32Array(4 * RATE), { startMs: 10_000 });
    assert.deepEqual(seen.lengths.slice(1), [2 * RATE, 2 * RATE, 2 * RATE, 2 * RATE]);
    assert.deepEqual(soundsText(report.labels), ['Speech 0:10 (0.70)', 'Music 0:11–0:14 (0.70)'], 'in order of time');
    assert.equal(seen.configs.length, 1, 'loaded once');
    assert.equal(tagger.loaded(), true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(tagger.loaded(), false, 'dropped after the idle time');
    assert.equal(collected, 1);
    assert.ok(log.entries.some((entry) => entry.message === 'sound tagger unloaded (idle)'));
  } finally { temp.cleanup(); }
});

test('SoundTagger: the CPU budget ends a tagging early (partial), a stop throws, low free memory never refuses it, a failed load is clear', async () => {
  const temp = tempDir();
  try {
    installFakeTagger(temp.dir);
    let clock = 0;
    const { addon } = fakeAddon(() => { clock += 400; return [{ name: 'Rain', prob: 0.9 }]; });
    const tagger = new SoundTagger({ dataDir: () => temp.dir, log: new MemoryLogger(), addon: () => addon, freeMemoryMb: () => 4000, now: () => clock, idleMs: 1 });
    const report = await tagger.tag(new Float32Array(30 * RATE), { budgetMs: 1_000 });
    assert.equal(report.partial, true);
    assert.deepEqual([report.startMs, report.endMs], [0, 3_000], 'three windows of 400 ms fit the budget');
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(tagger.tag(new Float32Array(3 * RATE), { signal: stop.signal }), /Stopped before the sounds were recognised/);

    // G4: the 80 MB tagger is a small model – Windows' low "free" reading never refuses it (the local speech engine's rule).
    const starved = new SoundTagger({ dataDir: () => temp.dir, log: new MemoryLogger(), addon: () => addon, freeMemoryMb: () => 40 });
    assert.ok(AUDIO_TAGGER.ramMb <= SMALL_MODEL_MB);
    assert.deepEqual((await starved.tag(new Float32Array(RATE))).labels.map((entry) => entry.label), ['Rain'], 'loaded and tagged with 40 MB "free"');
    const broken = new SoundTagger({ dataDir: () => temp.dir, log: new MemoryLogger(), freeMemoryMb: () => 4000, addon: () => ({ AudioTagging: class { constructor() { throw new Error('onnx: bad model'); } } as unknown as TaggerAddon['AudioTagging'] }) });
    await assert.rejects(broken.tag(new Float32Array(RATE)), /CED Mini could not be loaded on this PC/);
    const old = new SoundTagger({ dataDir: () => temp.dir, log: new MemoryLogger(), freeMemoryMb: () => 4000, addon: () => ({}) });
    await assert.rejects(old.tag(new Float32Array(RATE)), /cannot recognise sounds/);
    assert.deepEqual(await old.tag(new Float32Array(100)), { startMs: 0, endMs: 6, labels: [], partial: false }, 'nothing to hear: no model needed');
  } finally { temp.cleanup(); }
});

test('soundTagger: one per data folder, none without one; setSoundTagger puts a fake in place', () => {
  assert.equal(soundTagger({}), undefined);
  const a = soundTagger({ paths: { data: 'C:/data-a' } as never });
  assert.ok(a);
  assert.equal(soundTagger({ paths: { data: 'C:/data-a' } as never }), a);
  const fake = new SoundTagger({ dataDir: () => 'C:/data-b', log: new MemoryLogger() });
  setSoundTagger('C:/data-b', fake);
  assert.equal(soundTagger({ paths: { data: 'C:/data-b' } as never }), fake);
  setSoundTagger('C:/data-a', undefined);
  setSoundTagger('C:/data-b', undefined);
  assert.notEqual(soundTagger({ paths: { data: 'C:/data-a' } as never }), a);
  setSoundTagger('C:/data-a', undefined);
});

test('soundTagger: with a bus its download is ensureTagger\'s – a failure reaches the notice band as a voice.pull event', async () => {
  const temp = tempDir();
  // A data folder under a file: the install fails at once – nothing is fetched (no network in unit tests) or written.
  writeFileSync(path.join(temp.dir, 'blocker'), 'x');
  const data = path.join(temp.dir, 'blocker', 'data');
  try {
    const events: Array<[string, Record<string, unknown>]> = [];
    const bus = { emit: (name: string, payload: Record<string, unknown>) => { events.push([name, payload]); } };
    const tagger = soundTagger({ paths: { data, temp: temp.dir } as never, bus: bus as never, log: new MemoryLogger() })!;
    await assert.rejects(tagger.ensure());
    assert.deepEqual(events.map(([name, payload]) => [name, payload.id, payload.state, payload.auto]), [['voice.pull', 'ced-mini', 'failed', true]]);
    assert.equal(tagger.installed(), false);
  } finally { setSoundTagger(data, undefined); temp.cleanup(); }
});
