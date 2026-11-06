// Owns: a selected capture device is honored; only a missing/unsupported choice falls back.
// Never: opens physical devices (the Electron recorder test checks an actual fake camera).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMediaStream } from '../../../src/ui/blocks/ui/media-stream.ts';

test('the selected camera is requested exactly; a missing device falls back once, keeping other constraints', async () => {
  const constraints = { audio: { echoCancellation: true }, video: { deviceId: { exact: 'usb' }, width: { ideal: 1280 } } };
  const requests: MediaStreamConstraints[] = [];
  const stream = { camera: 'default' };
  const actual = await openMediaStream(async (request) => {
    requests.push(request);
    if (requests.length === 1) throw Object.assign(new Error('gone'), { name: 'OverconstrainedError' });
    return stream;
  }, constraints);
  assert.equal(actual, stream);
  assert.deepEqual(requests, [constraints, { audio: { echoCancellation: true }, video: { width: { ideal: 1280 } } }]);
  assert.deepEqual(constraints.video.deviceId, { exact: 'usb' }, 'the original choice is unchanged');
  let calls = 0;
  assert.equal(await openMediaStream(async () => { calls++; return stream; }, constraints), stream);
  assert.equal(calls, 1);
});

test('denials, devices in use and errors without an explicit device choice are never retried', async () => {
  for (const [name, constraints] of [
    ['NotAllowedError', { audio: { deviceId: { exact: 'mic' } } }],
    ['NotReadableError', { video: { deviceId: { exact: 'camera' } } }],
    ['NotFoundError', { audio: true }],
  ] as const) {
    let calls = 0;
    const error = Object.assign(new Error(name), { name });
    await assert.rejects(openMediaStream(async () => { calls++; throw error; }, constraints), (actual) => actual === error);
    assert.equal(calls, 1, name);
  }
});
