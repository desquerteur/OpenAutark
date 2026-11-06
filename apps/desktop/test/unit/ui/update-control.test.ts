// The update entry's rules (ui/shell/update-control.ts, SM12): what the rail and the compact item
// of narrow windows show per UpdateState, and the one action in Settings › About – "Download" on
// macOS, a retry after an error, nothing for states that need nobody; the "opens again by itself"
// text while it installs (B-078); the auto-download preference only where the app installs by itself.
// Owns: these assertions. Never: DOM, signals or the desktop bridge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UpdateState } from '../../../src/shared/model/system.ts';
import { RETRY_LABEL, aboutUpdateAction, autoDownloadApplies, installingText, updateControl } from '../../../src/ui/shell/update-control.ts';

const base: UpdateState = { status: 'idle', version: '0.2.0', percent: 0, automaticInstall: true };
const state = (change: Partial<UpdateState>): UpdateState => ({ ...base, ...change });

test('rail: available says "Update" with automatic install and "Download" on macOS; both apply()', () => {
  assert.deepEqual(updateControl(state({ status: 'available', availableVersion: '0.3.0' })), { glyph: 'download', label: 'Update', action: 'apply', percent: 0 });
  assert.deepEqual(
    updateControl(state({ status: 'available', availableVersion: '0.3.0', automaticInstall: false, downloadURL: 'https://github.com/x/releases/latest/download/a.dmg' })),
    { glyph: 'download', label: 'Download', action: 'apply', percent: 0 },
  );
});

test('rail: progress, ready and restarting keep their behaviour', () => {
  assert.deepEqual(updateControl(state({ status: 'downloading', percent: 41.6 })), { glyph: 'progress', label: 'Downloading (42 %)', action: null, percent: 42 });
  assert.equal(updateControl(state({ status: 'downloading', percent: 140 }))?.percent, 100, 'clamped');
  assert.deepEqual(updateControl(state({ status: 'downloaded', percent: 100 })), { glyph: 'ready', label: 'Restart to update', action: 'menu', percent: 100 });
  assert.deepEqual(updateControl(state({ status: 'installing', percent: 100 })), { glyph: 'restarting', label: 'Autark is installing the update and opens again by itself in about a minute.', action: null, percent: 100 });
});

test('rail: only a failed action for a verified available update shows retry', () => {
  const failed = updateControl(state({ status: 'error', failure: 'download', availableVersion: '0.3.0', message: 'Download failed. Click to try again.' }));
  assert.deepEqual(failed, { glyph: 'retry', label: 'Download failed. Click to try again.', action: 'apply', percent: 0 });
  for (const failure of ['download', 'open'] as const) {
    assert.equal(updateControl(state({ status: 'error', failure, availableVersion: '0.3.0' }))?.label, RETRY_LABEL);
    assert.equal(updateControl(state({ status: 'error', failure })), null, 'no retry without a verified update');
  }
  for (const availableVersion of [undefined, '0.3.0']) {
    assert.equal(updateControl(state({ status: 'error', failure: 'check', availableVersion })), null, 'a failed background check needs nobody');
    assert.equal(updateControl(state({ status: 'error', availableVersion })), null, 'an unclassified failure is not evidence for retry');
  }
});

test('rail: nothing for states that need nobody', () => {
  assert.equal(updateControl(null), null);
  for (const status of ['development', 'idle', 'checking', 'current'] as const) assert.equal(updateControl(state({ status })), null, status);
});

test('About: one action per state, all through apply()', () => {
  assert.equal(aboutUpdateAction(null), null);
  assert.deepEqual(aboutUpdateAction(state({ status: 'downloaded' })), { label: 'Restart to update', primary: true });
  assert.equal(aboutUpdateAction(state({ status: 'available' }))?.label, 'Update');
  const manual = aboutUpdateAction(state({ status: 'available', automaticInstall: false }));
  assert.equal(manual?.label, 'Download');
  assert.match(manual?.hint ?? '', /download page/);
  assert.deepEqual(aboutUpdateAction(state({ status: 'error', message: 'Could not check for updates. Retrying automatically.' })), { label: 'Try again', primary: false },
    'About offers a retry for every error, also a failed check');
  for (const status of ['development', 'idle', 'checking', 'downloading', 'installing', 'current'] as const) assert.equal(aboutUpdateAction(state({ status })), null, status);
});

test('installing: the app says it opens again by itself, Linux in seconds, elsewhere in about a minute', () => {
  const installing = state({ status: 'installing', availableVersion: '0.3.3', percent: 100 });
  assert.equal(installingText(installing, 'win32'), 'Autark is installing 0.3.3 and opens again by itself in about a minute.');
  assert.equal(installingText(installing, 'darwin'), 'Autark is installing 0.3.3 and opens again by itself in about a minute.');
  assert.equal(installingText(installing, 'linux'), 'Autark is installing 0.3.3 and opens again by itself in a few seconds.');
  assert.equal(installingText(state({ status: 'installing' })), 'Autark is installing the update and opens again by itself in about a minute.');
  assert.equal(updateControl(installing, 'linux')?.label, 'Autark is installing 0.3.3 and opens again by itself in a few seconds.');
});

test('About: the auto-download preference only where the app installs by itself', () => {
  assert.equal(autoDownloadApplies(state({ status: 'available' })), true);
  assert.equal(autoDownloadApplies(state({ status: 'available', automaticInstall: false })), false, 'macOS: installed by hand');
  assert.equal(autoDownloadApplies(null), true, 'no state yet: the stored preference stays editable');
});
