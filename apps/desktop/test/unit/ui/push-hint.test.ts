// Settings › Devices on a phone or a person's browser (ui/settings/connect-text.ts pushHint): what the Notifications
// row says once notifications are on – a person of the organisation gets the new messages of their chats (the runtime's
// pwa/person-push.ts rule), the owner's phone to-dos and blockers (and replies when it may chat) – and why a browser
// cannot turn them on.
// Owns: these assertions only. Never: the DOM, the browser's push API or the runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushHint } from '../../../src/ui/settings/connect-text.ts';

test('on: a person hears about their chats, the owner\'s phone about to-dos', () => {
  assert.equal(pushHint('on', { person: true, chat: true }), 'New messages in your chats reach this phone');
  assert.equal(pushHint('on', { person: false, chat: true }), 'To-dos, blockers and replies reach this phone');
  assert.equal(pushHint('on', { person: false, chat: false }), 'To-dos and blockers reach this phone');
});

test('a browser that cannot have notifications says why; off and unread say nothing', () => {
  const who = { person: true, chat: true };
  assert.match(pushHint('blocked', who) ?? '', /browser settings/);
  assert.match(pushHint('unsupported', who) ?? '', /cannot show notifications/);
  assert.match(pushHint('unsupported', { ...who, iosTab: true }) ?? '', /Add to Home Screen.*connect again.*Home Screen app/, 'the iPhone app in a Safari tab shows the way');
  assert.equal(pushHint('on', { ...who, iosTab: true }), 'New messages in your chats reach this phone');
  assert.match(pushHint('insecure', who) ?? '', /HTTPS/);
  assert.equal(pushHint('off', who), undefined);
  assert.equal(pushHint(undefined, who), undefined);
});
