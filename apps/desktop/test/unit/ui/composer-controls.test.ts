// 21.10. 17:09 in the composer and the shell (src/ui/chat/composer/controls.ts, src/ui/shell/work-stop.ts):
// Send with content, disabled without; AF-012: while an agent works in the chat an empty draft turns the cell into
// Stop (a draft keeps Send, so a message still reaches the running agent). Who may press the emergency stop's Stop /
// Resume, from the real handler table (a To-do-only phone may brake, not resume).
// Owns: these assertions only (the window checks: test/ui/composer-no-stop-window.test.mjs, composer-stop-window.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composerControls } from '../../../src/ui/chat/composer/controls.ts';
import { workAction } from '../../../src/ui/shell/work-stop.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { sessionInfo } from '../../../src/runtime/rpc/handlers/session.ts';
import { FULL_ACCESS } from '../../../src/runtime/pwa/tokens.ts';
import type { MethodName } from '../../../src/shared/api/methods.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import type { WorkStopState } from '../../../src/shared/model/work-stop.ts';

test('the composer only sends: empty drafts and pending transcriptions cannot be sent', () => {
  assert.deepEqual(composerControls({ hasContent: false, transcribing: false }), { primary: 'send-disabled' });
  assert.deepEqual(composerControls({ hasContent: true, transcribing: false }), { primary: 'send' });
  assert.deepEqual(composerControls({ hasContent: true, transcribing: true }), { primary: 'send-disabled' });
});

test('AF-012: an agent at work turns an empty composer cell into Stop; a draft or a pending dictation keeps Send', () => {
  assert.deepEqual(composerControls({ hasContent: false, transcribing: false, working: true }), { primary: 'stop' });
  assert.deepEqual(composerControls({ hasContent: true, transcribing: false, working: true }), { primary: 'send' }, 'a draft still goes to the running agent');
  assert.deepEqual(composerControls({ hasContent: false, transcribing: true, working: true }), { primary: 'send-disabled' }, 'the dictated words are on their way');
  assert.deepEqual(composerControls({ hasContent: false, transcribing: false, working: false }), { primary: 'send-disabled' });
});

const table = createHandlerTable();
const mayFor = (scope: ClientScope) => {
  const allowed = new Set<string>(sessionInfo(table, scope).allowedMethods);
  return (method: MethodName) => allowed.has(method);
};
const OWNER = mayFor({ kind: 'owner' });
const FULL_PHONE = mayFor({ kind: 'device', deviceId: 'dev_ipad', capabilities: [...FULL_ACCESS], secure: false });
const state = (patch: Partial<WorkStopState> = {}): WorkStopState => ({ stopped: false, at: 1, ...patch });

test('emergency stop: Stop and Resume for the owner and every paired device', () => {
  assert.equal(workAction(state(), FULL_PHONE), 'stop', 'every paired device may brake');
  assert.equal(workAction(state({ stopped: true }), FULL_PHONE), 'resume');
  assert.equal(workAction(null, OWNER), 'stop');
});
