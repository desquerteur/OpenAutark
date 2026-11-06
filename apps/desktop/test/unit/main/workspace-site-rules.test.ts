// The person's browser beside the chat: one fixed permission rule (main/workspace-session.ts – the page's own site
// may use camera, microphone, notifications, fullscreen and clipboard writes; everything else and every other site's
// frame are refused) and where downloads go (main/workspace-downloads.ts: <workspace>/downloads/personal, safe and
// unique names).
// Owns: these assertions only. Never: electron or real files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { siteMay, siteOf } from '../../../src/main/workspace-session.ts';
import { downloadName, personalDownloads, uniqueDownload } from '../../../src/main/workspace-downloads.ts';

test('the fixed rule: the page\'s own site may use camera, microphone, notifications, fullscreen and clipboard writes', () => {
  const page = 'https://meet.example.com/room/1';
  for (const permission of ['media', 'notifications', 'fullscreen', 'clipboard-sanitized-write']) assert.equal(siteMay(permission, 'https://meet.example.com/', page), true, permission);
  for (const permission of ['geolocation', 'midi', 'clipboard-read', 'hid', 'openExternal']) assert.equal(siteMay(permission, 'https://meet.example.com/', page), false, permission);
  assert.equal(siteMay('media', 'https://ads.other.example/', page), false, 'a frame of another site');
  assert.equal(siteMay('media', 'file:///C:/x', 'file:///C:/x'), false, 'only http(s) sites');
  assert.equal(siteMay('media', undefined, page), false);
  assert.equal(siteOf('https://a.example:8443/x?y'), 'https://a.example:8443');
  assert.equal(siteOf('chrome://settings'), undefined);
});

test('downloads: <workspace>/downloads/personal, a safe name, unique in the folder', () => {
  const dir = personalDownloads(path.join('C:', 'Users', 'ann', 'Workforce'));
  assert.equal(dir, path.join('C:', 'Users', 'ann', 'Workforce', 'downloads', 'personal'));
  assert.equal(downloadName('report.pdf'), 'report.pdf');
  assert.equal(downloadName('..\\..\\evil.exe'), 'evil.exe', 'no path parts');
  assert.equal(downloadName('a<b>:c"d|e?f*.txt'), 'a_b__c_d_e_f_.txt');
  assert.equal(downloadName('CON.txt'), '_CON.txt', 'no device names');
  assert.equal(downloadName('  ...  '), 'download');
  const long = downloadName(`${'x'.repeat(300)}.tar.gz`);
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('.gz'), 'the extension stays');
  const taken = new Set([path.join(dir, 'report.pdf'), path.join(dir, 'report (2).pdf')]);
  assert.equal(uniqueDownload(dir, 'report.pdf', (file) => taken.has(file)), path.join(dir, 'report (3).pdf'));
  assert.equal(uniqueDownload(dir, 'notes', (file) => taken.has(file)), path.join(dir, 'notes'));
});
