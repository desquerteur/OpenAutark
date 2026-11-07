// AF-002: while the setup assistant is open, a click on another place than My day no longer hides it without a trace:
// the status line says the setup is not finished, with Continue setup (src/ui/onboarding/setup-reminder.ts). On My day
// itself ('home' or 'day') the assistant is on screen, so there is no line; once the setup ends there is none.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETUP_NOTICE_ID, SETUP_NOTICE_TEXT, setupNotice } from '../../../src/ui/onboarding/setup-reminder.ts';

test('the line shows away from My day while the assistant is open, with Continue setup', () => {
  let resumed = 0;
  const notice = setupNotice({ open: true, view: 'chats' }, () => { resumed += 1; });
  assert.equal(notice?.id, SETUP_NOTICE_ID);
  assert.equal(notice?.text, SETUP_NOTICE_TEXT);
  assert.equal(notice?.onDismiss, undefined, 'a status, not an offer');
  assert.deepEqual(notice?.actions?.map((action) => action.label), ['Continue setup']);
  notice?.actions?.[0].run();
  assert.equal(resumed, 1);
  for (const view of ['team', 'tasks', 'settings', 'chat']) assert.ok(setupNotice({ open: true, view }, () => undefined), view);
});

test('no line on My day itself or once the setup is through', () => {
  assert.equal(setupNotice({ open: true, view: 'home' }, () => undefined), null);
  assert.equal(setupNotice({ open: true, view: 'day' }, () => undefined), null);
  assert.equal(setupNotice({ open: false, view: 'chats' }, () => undefined), null);
});
