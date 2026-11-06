// The status line's computer-use line (src/ui/shell/computer-notice.ts): while an agent uses this PC and computer use
// is not stopped, one info line says who and what, with [Watch] – it opens the Screen tab (the only way into it).
// The Watch cell is part of the line: there for the whole time the line is, absent only without the screen preview.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ComputerActivityState } from '../../../src/shared/model/computer.ts';
import { COMPUTER_NOTICE_ID, computerNotice } from '../../../src/ui/shell/computer-notice.ts';
import { NOTICE_PRIORITY } from '../../../src/ui/shell/notices.ts';

const state = (extra: Partial<ComputerActivityState> = {}): ComputerActivityState => ({ active: true, stopped: false, at: 1, ...extra });

test('an agent using this PC: one info line naming the agent and the step, with Watch that opens the Screen tab', () => {
  const opened: string[] = [];
  const notice = computerNotice(state({ agent: 'Mira', summary: 'Click at 120,300' }), true, () => opened.push('screen'));
  assert.equal(notice?.id, COMPUTER_NOTICE_ID);
  assert.equal(notice?.tone, 'info');
  assert.equal(notice?.priority, NOTICE_PRIORITY.computer);
  assert.equal(notice?.text, 'Mira is using this PC · Click at 120,300');
  assert.equal(notice?.onDismiss, undefined, 'a status, not an offer to dismiss');
  assert.deepEqual(notice?.actions?.map((action) => action.label), ['Watch']);
  notice?.actions?.[0].run();
  assert.deepEqual(opened, ['screen']);
});

test('without a name or step the line still reads, and nothing shows while idle, stopped or unknown', () => {
  assert.equal(computerNotice(state(), true, () => undefined)?.text, 'An agent is using this PC');
  assert.equal(computerNotice(null, true, () => undefined), null);
  assert.equal(computerNotice(state({ active: false }), true, () => undefined), null);
  assert.equal(computerNotice(state({ stopped: true }), true, () => undefined), null, 'Stop / Resume live in the Screen tab');
});

test('a connection without the screen preview gets the line but no Watch', () => {
  const notice = computerNotice(state({ agent: 'Mira' }), false, () => undefined);
  assert.equal(notice?.text, 'Mira is using this PC');
  assert.equal(notice?.actions, undefined);
});
