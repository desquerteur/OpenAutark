import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEDIA_ARM_MS, MediaArm, allowPermissionCheck, allowPermissionRequest, externalUrl, isAppUrl, isTrustedSender,
  mainFrameNavigation, subFrameNavigationAllowed, windowOpenDecision,
} from '../../../src/main/security.ts';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

test('trust check: only our window main frame at app://app', () => {
  const ok = { contentsId: 7, isMainFrame: true, frameUrl: 'app://app/index.html' };
  assert.equal(isTrustedSender(ok, 7), true);
  assert.equal(isTrustedSender(ok, 8), false, 'another webContents');
  assert.equal(isTrustedSender(ok, null), false, 'no window');
  assert.equal(isTrustedSender({ ...ok, isMainFrame: false }, 7), false, 'sub-frame (mini-app)');
  assert.equal(isTrustedSender({ ...ok, frameUrl: 'wf-sandbox://app/msg_0123456789abcdef/0' }, 7), false);
  assert.equal(isTrustedSender({ ...ok, frameUrl: 'https://example.com/' }, 7), false);
  assert.equal(isTrustedSender({ ...ok, frameUrl: 'app://evil/index.html' }, 7), false, 'wrong host');
  assert.equal(isTrustedSender({ ...ok, frameUrl: null }, 7), false, 'destroyed frame');
  assert.equal(isAppUrl('app://app/index.html'), true);
  assert.equal(isAppUrl('app://evil/index.html'), false);
});

test('external links: http(s) always, mailto only when allowed, nothing else', () => {
  assert.equal(externalUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(externalUrl('http://example.com'), 'http://example.com/');
  assert.equal(externalUrl('mailto:a@example.com'), null);
  assert.equal(externalUrl('mailto:a@example.com', { mailto: true }), 'mailto:a@example.com');
  for (const bad of ['javascript:alert(1)', 'file:///C:/Windows/System32/calc.exe', 'ms-settings:privacy', 'app://app/index.html', 'https://user:pw@example.com/', 'not a url', 42, null]) {
    assert.equal(externalUrl(bad as string, { mailto: true }), null, String(bad));
  }
  assert.equal(externalUrl(`https://example.com/${'a'.repeat(5000)}`), null, 'too long');
});

test('navigation: main frame stays on app://app, sub-frames only load mini-apps', () => {
  assert.deepEqual(mainFrameNavigation('app://app/index.html#/chats'), { allow: true });
  assert.deepEqual(mainFrameNavigation('https://example.com/'), { allow: false, openExternal: 'https://example.com/' });
  assert.deepEqual(mainFrameNavigation('file:///etc/passwd'), { allow: false });
  assert.equal(subFrameNavigationAllowed('wf-sandbox://app/msg_01jab3k9z7mx2c4q/2'), true);
  assert.equal(subFrameNavigationAllowed('wf-sandbox://plugin-focus-mode/focus-mode/?v=2'), false, 'overlay plugins are gone');
  assert.equal(subFrameNavigationAllowed('about:blank'), true);
  assert.equal(subFrameNavigationAllowed('wf-sandbox://lib/wf.js'), false);
  assert.equal(subFrameNavigationAllowed('https://evil.example/'), false);
  assert.equal(subFrameNavigationAllowed('app://app/index.html'), false);
  assert.deepEqual(windowOpenDecision('https://example.com/x'), { action: 'deny', openExternal: 'https://example.com/x' });
  assert.deepEqual(windowOpenDecision('javascript:void 0'), { action: 'deny' });
});

test('media arming expires after 15 s and is per kind', () => {
  const time = clock();
  const media = new MediaArm({ now: time.now });
  assert.equal(media.armed('audio'), false);
  media.arm(['audio']);
  assert.equal(media.armed('audio'), true);
  assert.equal(media.armed('video'), false);
  time.advance(MEDIA_ARM_MS - 1);
  assert.equal(media.armed('audio'), true);
  time.advance(1);
  assert.equal(media.armed('audio'), false, 'expired');
  media.arm(['audio', 'video']);
  media.disarm('audio');
  assert.equal(media.armed('audio'), false);
  assert.equal(media.armed('video'), true);
  media.disarm();
  assert.equal(media.armed('video'), false);
});

test('permission requests: default deny, media only while armed for every kind', () => {
  const time = clock();
  const media = new MediaArm({ now: time.now });
  const request = (permission: string, mediaTypes?: string[], trusted = true) => allowPermissionRequest({ trusted, permission, mediaTypes }, media);
  assert.equal(request('media', ['audio']), false, 'not armed');
  media.arm(['audio']);
  assert.equal(request('media', ['audio']), true);
  assert.equal(request('media', ['audio', 'video']), false, 'video not armed');
  assert.equal(request('media', []), false);
  assert.equal(request('media', ['audio'], false), false, 'untrusted frame');
  assert.equal(request('clipboard-sanitized-write'), true);
  assert.equal(request('clipboard-sanitized-write', undefined, false), false);
  for (const permission of ['notifications', 'geolocation', 'openExternal', 'clipboard-read', 'midi', 'hid', 'display-capture']) {
    assert.equal(request(permission), false, permission);
  }
  time.advance(MEDIA_ARM_MS);
  assert.equal(request('media', ['audio']), false, 'expired');
});

test('permission checks mirror the request rules', () => {
  const media = new MediaArm();
  assert.equal(allowPermissionCheck({ trusted: true, permission: 'media', mediaType: 'audio' }, media), false);
  media.arm(['video']);
  assert.equal(allowPermissionCheck({ trusted: true, permission: 'media', mediaType: 'video' }, media), true);
  assert.equal(allowPermissionCheck({ trusted: true, permission: 'media', mediaType: 'unknown' }, media), false);
  assert.equal(allowPermissionCheck({ trusted: false, permission: 'media', mediaType: 'video' }, media), false);
  assert.equal(allowPermissionCheck({ trusted: true, permission: 'fullscreen' }, media), true);
  assert.equal(allowPermissionCheck({ trusted: true, permission: 'notifications' }, media), false);
});
