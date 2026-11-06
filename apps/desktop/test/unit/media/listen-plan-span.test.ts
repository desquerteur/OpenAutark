// B-058 media.listen spans and the decoder's reach (src/runtime/tools/builtin/media-listen-plan.ts): the host's decoder
// holds all sound from a file's start, so a part it decodes must end within the first 30 minutes (main/media-audio.ts
// WHOLE_MS) – a later start is refused with a clear message, a part reaching past 30:00 is clipped, and the "more" line
// says that later parts cannot be decoded here instead of naming a call that would be refused. WAV is read here, any part.
// Owns: these assertions only. Never: decodes, listens or reads files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WHOLE_MS } from '../../../src/main/media-audio.ts';
import { DECODE_END_MS, listenPlan, moreAfter } from '../../../src/runtime/tools/builtin/media-listen-plan.ts';
import { listen } from '../../../src/runtime/tools/builtin/media-listen.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import type { MediaInfo } from '../../../src/shared/model/media.ts';

const ctx = {} as ToolContext; // a decoded span's plan reads nothing
const MINUTES_45 = 45 * 60_000;
const video: MediaInfo = { fileId: 'f'.repeat(64), kind: 'video', mime: 'video/mp4', name: 'call.mp4', size: 400_000_000, durationMs: MINUTES_45, createdAt: 1, updatedAt: 1 };
const recording: MediaInfo = { fileId: 'a'.repeat(64), kind: 'audio', mime: 'audio/wav', name: 'call.wav', size: 300_000_000, durationMs: MINUTES_45, createdAt: 1, updatedAt: 1 };
const plan = (info: MediaInfo, start?: number, end?: number) => listenPlan(ctx, info, { fileId: info.fileId, start, end });

test('the runtime knows the decoder limit main enforces', () => {
  assert.equal(DECODE_END_MS, WHOLE_MS);
});

test('a part the host decodes ends by 30:00: later starts refused, a part reaching past it clipped; a WAV anywhere', () => {
  assert.deepEqual(plan(video, 1600, 1900), { original: false, startMs: 1_600_000, maxMs: 200_000, seconds: 200 }, '26:40–31:40 → 26:40–30:00');
  assert.deepEqual(plan(video, 1500), { original: false, startMs: 1_500_000, maxMs: 300_000, seconds: 300 }, 'ends exactly at 30:00');
  assert.deepEqual(plan(video, 1799), { original: false, startMs: 1_799_000, maxMs: 1_000, seconds: 1 });
  for (const start of [1799.5, 1800, 2400]) {
    const refused = plan(video, start) as { refused?: string };
    assert.match(String(refused.refused), /^Only the first 30 minutes of this recording can be decoded here: ask for a part that ends by 30:00/, `start ${start}`);
  }
  assert.deepEqual(plan(recording, 2400, 2700), { original: false, startMs: 2_400_000, maxMs: 300_000, seconds: 300 }, 'a WAV is read here: no limit');
  assert.match(String((plan(video, 3000) as { refused?: string }).refused), /only 45:00 long/, 'past the end: that message first');
});

test('"more" names the next call only where it can be heard', () => {
  assert.equal(moreAfter(video, 5 * 60_000), 'The recording goes on after 5:00: call media.listen again with start 300 for the next part.');
  assert.equal(moreAfter(video, DECODE_END_MS), 'The recording goes on after 30:00, but later parts of it cannot be decoded here; send them as a file of their own.');
  assert.match(moreAfter(recording, DECODE_END_MS), /call media\.listen again with start 1800/);
});

test('the end argument says so (lean)', () => {
  const end = (listen.inputSchema as { properties: { end: { description: string } } }).properties.end.description;
  assert.match(end, /by 1800 – the first 30 minutes – unless the file is a WAV/);
});
