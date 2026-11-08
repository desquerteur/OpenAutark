// The release locations (src/main/updates/release.ts, B-078): one public home teydra/OpenAutark for the manual download,
// the packaged feed (package.json build.publish) and the push contact (VAPID_SUBJECT); the stable latest-download names.
// Owns: these assertions only. Never: network access.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { RELEASE_REPOSITORY, RELEASE_URL, downloadName, downloadURL } from '../../../src/main/updates/release.ts';
import { VAPID_SUBJECT } from '../../../src/runtime/pwa/vapid.ts';

const LATEST = 'https://github.com/desquerteur/OpenAutark/releases/latest/download/';

test('the stable latest-download links point at OpenAutark', () => {
  assert.equal(RELEASE_REPOSITORY, 'desquerteur/OpenAutark');
  assert.equal(RELEASE_URL, 'https://github.com/desquerteur/OpenAutark/releases');
  assert.equal(downloadURL('win32', 'x64'), `${LATEST}autark-windows-x64.exe`);
  assert.equal(downloadURL('darwin', 'arm64'), `${LATEST}autark-mac-universal.dmg`);
  assert.equal(downloadURL('darwin', 'x64'), `${LATEST}autark-mac-universal.dmg`);
  assert.equal(downloadURL('linux', 'x64'), `${LATEST}autark-linux-x64.AppImage`);
  assert.equal(downloadName('linux', 'arm64'), null);
  assert.equal(downloadURL('win32', 'arm64'), null);
});

test('the packaged feed and the push contact name the same repository; the appId stays', () => {
  const pkg = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as { build: { appId: string; publish: { provider: string; owner: string; repo: string } } };
  assert.equal(`${pkg.build.publish.owner}/${pkg.build.publish.repo}`, RELEASE_REPOSITORY);
  assert.equal(pkg.build.publish.provider, 'github');
  assert.equal(pkg.build.appId, 'com.teydralab.workforce', 'same NSIS GUID and data for every install');
  assert.equal(VAPID_SUBJECT, `https://github.com/${RELEASE_REPOSITORY}`);
});
