// B-058 F2 (live 30.10.: up to 5.8 s between "microphone open" and the tap lost the first words): lib/microphone.ts
// readies its audio graph while the device opens – the context exists before getUserMedia answers and the first
// block after it is delivered; where the browser cannot resample, the device rate is used; a refused microphone
// closes the readied graph.
// Owns: these assertions only. Never: a real device or audio graph.

import { test } from 'node:test';
import assert from 'node:assert/strict';

type Block = { inputBuffer: { getChannelData(): Float32Array } };
const contexts: FakeContext[] = [];
let refuseRate = false;
class FakeContext {
  readonly sampleRate: number;
  readonly destination = {};
  closed = false;
  processor: { onaudioprocess: ((event: Block) => void) | null } | null = null;
  constructor(options?: { sampleRate?: number }) { this.sampleRate = options?.sampleRate ?? 48_000; contexts.push(this); }
  createMediaStreamSource() {
    if (refuseRate && this.sampleRate !== 48_000) throw new Error('Connecting AudioNodes from AudioContexts with different sample-rate is not supported');
    return { connect() {}, disconnect() {} };
  }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  createScriptProcessor() { const node = { onaudioprocess: null, connect() {}, disconnect() {} }; this.processor = node; return node; }
  async resume() {}
  async close() { this.closed = true; }
}
const device: { open?: (stream: unknown) => void; refuse?: (error: Error) => void } = {};
Object.assign(globalThis, { AudioContext: FakeContext });
Object.defineProperty(navigator, 'mediaDevices', {
  configurable: true,
  value: { getUserMedia: () => new Promise((resolve, reject) => { device.open = resolve; device.refuse = reject; }) },
});

const { openMicrophone } = await import('../../../src/ui/lib/microphone.ts');
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function stream() {
  const track = { stopped: false, stop() { this.stopped = true; } };
  return { track, stream: { getTracks: () => [track] } };
}
const block = (context: FakeContext) => context.processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4) } });

test('the graph is readied while the device opens: the context exists before getUserMedia answers, the first block is delivered', async () => {
  contexts.length = 0;
  refuseRate = false;
  const rates: number[] = [];
  const opening = openMicrophone((_samples, rate) => rates.push(rate), { sampleRate: 16_000 });
  await settle();
  assert.equal(contexts.length, 1, 'readied before the device answered');
  assert.equal(contexts[0].sampleRate, 16_000);
  const opened = stream();
  device.open?.(opened.stream);
  const mic = await opening;
  block(contexts[0]);
  assert.deepEqual(rates, [16_000]);
  mic.close();
  assert.equal(contexts[0].closed, true);
  assert.equal(opened.track.stopped, true);
});

test('a browser that cannot resample the stream: the readied 16 kHz graph is closed, the device rate is used', async () => {
  contexts.length = 0;
  refuseRate = true;
  const rates: number[] = [];
  const opening = openMicrophone((_samples, rate) => rates.push(rate), { sampleRate: 16_000 });
  await settle();
  device.open?.(stream().stream);
  const mic = await opening;
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].closed, true, 'the 16 kHz graph is gone');
  block(contexts[1]);
  assert.deepEqual(rates, [48_000]);
  mic.close();
  refuseRate = false;
});

test('a refused microphone closes the readied graph and says why', async () => {
  contexts.length = 0;
  const opening = openMicrophone(() => undefined, { sampleRate: 16_000 });
  await settle();
  device.refuse?.(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
  await assert.rejects(opening, { name: 'NotAllowedError' });
  await settle();
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].closed, true, 'no audio context is left running');
});

test('without a sample listener only the stream is opened, no audio graph', async () => {
  contexts.length = 0;
  const opening = openMicrophone();
  await settle();
  device.open?.(stream().stream);
  await opening;
  assert.equal(contexts.length, 0);
});
