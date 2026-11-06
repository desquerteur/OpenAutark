// UpdateService after failures (SM12 review): a failure's text names the call that failed – a
// failed check after a failed download or browser open says it could not check, not the earlier
// text –, a failed background check keeps a found update offered, and a "Download" click on macOS
// opens the download page also while a background check runs.
// Owns: these assertions. Never: electron, network or real timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGES, failureText } from '../../../src/main/updates/failures.ts';
import { OPEN_FAILED } from '../../../src/main/updates/manual-download.ts';
import { downloadURL } from '../../../src/main/updates/release.ts';
import { harness } from './update-fakes.ts';

test('macOS: a check that fails after a failed open says it could not check', async () => {
  const h = harness({ platform: 'darwin', arch: 'arm64', openExternal: async () => { throw new Error('no browser'); } });
  await h.service.check();
  await h.service.apply();
  assert.deepEqual([h.service.state.status, h.service.state.message], ['error', OPEN_FAILED]);
  h.fail.check = 1;
  await h.service.check(); // the background check, offline now
  assert.equal(h.service.state.status, 'error');
  assert.equal(h.service.state.message, MESSAGES.check, 'not "Could not open the download page"');
  assert.equal(h.service.state.availableVersion, '0.3.0', 'the found update stays known');
  h.service.dispose();
});

test('a check that fails after a failed download says it could not check; the next good check offers the update again', async () => {
  const h = harness({ script: { downloadFails: 1 } });
  await h.service.check();
  await h.service.apply();
  assert.equal(h.service.state.message, MESSAGES.download);
  h.fail.check = 1;
  await h.service.check();
  assert.deepEqual([h.service.state.status, h.service.state.message], ['error', MESSAGES.check]);
  await h.service.check();
  assert.equal(h.service.state.status, 'available');
  assert.equal(h.service.state.message, undefined);
  h.service.dispose();
});

test('a failed background check keeps a found update offered', async () => {
  const h = harness();
  await h.service.check();
  assert.equal(h.service.state.status, 'available');
  const before = h.states.length;
  h.fail.check = 1;
  await h.service.check();
  assert.equal(h.service.state.status, 'available');
  assert.equal(h.service.state.message, undefined);
  assert.ok(!h.states.slice(before).some((state) => state.status === 'error'), 'no error state in between');
  await h.service.apply();
  assert.equal(h.calls.install, 1, 'the offer still installs');
  h.service.dispose();
});

test('macOS: a "Download" click during a background check opens the download page', async () => {
  const script: { hold?: Promise<void> } = {};
  const h = harness({ platform: 'darwin', arch: 'x64', script });
  await h.service.check();
  let release!: () => void;
  script.hold = new Promise<void>((resolve) => { release = resolve; });
  const checking = h.service.check(); // waits on the network
  await h.service.apply();
  assert.deepEqual(h.opened, [downloadURL('darwin', 'x64')], 'the click is not dropped');
  release();
  await checking;
  assert.equal(h.service.state.status, 'available');
  h.service.dispose();
});

test('failureText: the call in flight decides; an unprompted report keeps a known error text', () => {
  assert.equal(failureText('check', { status: 'error', message: OPEN_FAILED }), MESSAGES.check);
  assert.equal(failureText('download', { status: 'error', message: MESSAGES.download }), MESSAGES.download, 'the second report of one failure');
  assert.equal(failureText(undefined, { status: 'downloading' }), MESSAGES.download);
  assert.equal(failureText(undefined, { status: 'error', message: OPEN_FAILED }), OPEN_FAILED);
  assert.equal(failureText(undefined, { status: 'current' }), MESSAGES.check);
});
