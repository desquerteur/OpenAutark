// The marks on the person's browser tabs (src/main/workspace-marks.ts): a background tab until it is shown, the agent that
// opened a tab, and an agent's preview tab – found per agent and space, gone once the person uses or keeps it or it
// closes; the page entry says background and transient; and the IPC check lets the window send 'keep'.
// Owns: these assertions only. Never: Electron or a real page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TabMarks } from '../../../src/main/workspace-marks.ts';
import { browserCommand } from '../../../src/main/workspace-commands.ts';

const ada = { agentId: 'ag_ada', agentName: 'Ada', chatId: 'ch_1' };
const bo = { agentId: 'ag_bo', agentName: 'Bo' };

test('a background tab stays one until it is shown; the opener stays until the tab closes', () => {
  const marks = new TabMarks();
  marks.opened('web-a', false, ada);
  assert.deepEqual(marks.page('web-a'), { background: true });
  assert.deepEqual(marks.opener('web-a'), ada);
  assert.equal(marks.shown('web-a'), true, 'the first show changes the entry');
  assert.equal(marks.shown('web-a'), false, 'later shows change nothing');
  assert.deepEqual(marks.page('web-a'), {});
  marks.opened('web-b', true);
  assert.deepEqual(marks.page('web-b'), {}, 'a tab opened shown is no background tab');
  assert.equal(marks.opener('web-b'), undefined, 'the person opened it');
  marks.closed('web-a');
  assert.equal(marks.opener('web-a'), undefined);
});

test("an agent's preview tab: one per agent and space, found again until the person uses it, keeps it or closes it", () => {
  const marks = new TabMarks();
  const spaces: Record<string, string> = { 'web-p': 'chat:ch_1', 'web-q': 'global', 'web-r': 'chat:ch_1' };
  const inSpace = (space: string) => (id: string) => spaces[id] === space;
  marks.opened('web-p', true, ada, true);
  marks.opened('web-q', false, ada, true);
  marks.opened('web-r', false, bo, true);
  assert.deepEqual(marks.page('web-p'), { transient: true });
  assert.deepEqual(marks.page('web-q'), { background: true, transient: true });
  assert.equal(marks.previewOf('ag_ada', inSpace('chat:ch_1')), 'web-p', "Ada's preview in the chat's area");
  assert.equal(marks.previewOf('ag_ada', inSpace('global')), 'web-q', "and her own one in the person's pane");
  assert.equal(marks.previewOf('ag_bo', inSpace('chat:ch_1')), 'web-r', 'each agent its own');
  assert.equal(marks.previewOf('ag_bo', inSpace('global')), undefined);
  assert.equal(marks.keep('web-p'), true, 'the person used it: a tab of its own');
  assert.equal(marks.keep('web-p'), false, 'only once');
  assert.deepEqual(marks.page('web-p'), {});
  assert.equal(marks.previewOf('ag_ada', inSpace('chat:ch_1')), undefined, 'her next page opens a new preview tab');
  assert.deepEqual(marks.opener('web-p'), ada, 'it still names the agent that opened it');
  marks.closed('web-q');
  assert.equal(marks.previewOf('ag_ada', inSpace('global')), undefined, 'a closed preview is gone');
});

test('a page a person, a site or a menu opens is never a preview; only a tab with an agent can be one', () => {
  const marks = new TabMarks();
  marks.opened('web-x', true, undefined, true);
  assert.deepEqual(marks.page('web-x'), {});
  marks.opened('web-y', false, ada);
  assert.deepEqual(marks.page('web-y'), { background: true }, "a site's page an agent's tab opened carries the agent, as no preview");
  assert.equal(marks.previewOf('ag_ada', () => true), undefined);
});

test("the window may send 'keep' for a tab of the browser's own form, nothing else", () => {
  assert.equal(browserCommand({ action: 'keep', id: 'web-a' }).action, 'keep');
  for (const bad of [{ action: 'keep' }, { action: 'keep', id: null }, { action: 'keep', id: '../x' }]) {
    assert.throws(() => browserCommand(bad), /Invalid browser/);
  }
});
