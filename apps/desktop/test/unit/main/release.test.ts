// The release locations (src/main/updates/release.ts, B-078, AF-019): this build's default source is the fork
// desquerteur/OpenAutark (manual download and the packaged feed, package.json build.publish), the upstream
// teydra/OpenAutark stays selectable and keeps the push contact (VAPID_SUBJECT); the stable latest-download names.
// Owns: these assertions only. Never: network access.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { RELEASE_REPOSITORY, RELEASE_URL, UPSTREAM_REPOSITORY, downloadName, downloadURL, releasesURL } from '../../../src/main/updates/release.ts';
import { VAPID_SUBJECT } from '../../../src/runtime/pwa/vapid.ts';

const LATEST = 'https://github.com/desquerteur/OpenAutark/releases/latest/download/';

test('the stable latest-download links point at the fork by default, at another source when given', () => {
  assert.equal(RELEASE_REPOSITORY, 'desquerteur/OpenAutark');
  assert.equal(UPSTREAM_REPOSITORY, 'teydra/OpenAutark');
  assert.equal(RELEASE_URL, 'https://github.com/desquerteur/OpenAutark/releases');
  assert.equal(downloadURL('win32', 'x64'), `${LATEST}autark-windows-x64.exe`);
  assert.equal(downloadURL('darwin', 'arm64'), `${LATEST}autark-mac-universal.dmg`);
  assert.equal(downloadURL('darwin', 'x64'), `${LATEST}autark-mac-universal.dmg`);
  assert.equal(downloadURL('linux', 'x64'), `${LATEST}autark-linux-x64.AppImage`);
  assert.equal(downloadURL('win32', 'x64', UPSTREAM_REPOSITORY), 'https://github.com/teydra/OpenAutark/releases/latest/download/autark-windows-x64.exe');
  assert.equal(releasesURL('someone/Fork'), 'https://github.com/someone/Fork/releases');
  assert.equal(downloadName('linux', 'arm64'), null);
  assert.equal(downloadURL('win32', 'arm64'), null);
});

test('the packaged feed names the default source; the push contact and the appId stay', () => {
  const pkg = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as { build: { appId: string; win: { artifactName: string }; publish: { provider: string; owner: string; repo: string } } };
  assert.equal(`${pkg.build.publish.owner}/${pkg.build.publish.repo}`, RELEASE_REPOSITORY);
  assert.equal(pkg.build.publish.provider, 'github');
  assert.equal(pkg.build.appId, 'com.teydralab.workforce', 'same NSIS GUID and data for every install');
  assert.equal(pkg.build.win.artifactName.replace('${arch}', 'x64').replace('${ext}', 'exe'), downloadName('win32', 'x64'), 'the installer name the updater and the fork workflow expect');
  assert.equal(VAPID_SUBJECT, `https://github.com/${UPSTREAM_REPOSITORY}`);
});
