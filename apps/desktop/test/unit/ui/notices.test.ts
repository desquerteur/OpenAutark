// The status line's data and its connection line (ui/shell/notices.ts): providers are
// functions of signals, the order is priority then registration, one notice per id, at most two actions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signal } from '@preact/signals';
import { NOTICE_PRIORITY, connectionNotice, orderNotices, registerNotice, visibleNotices } from '../../../src/ui/shell/notices.ts';
import type { Notice } from '../../../src/ui/shell/notices.ts';

const notice = (id: string, priority: number, extra: Partial<Notice> = {}): Notice => ({ id, tone: 'info', text: id, priority, ...extra });
const ids = (list: readonly Notice[]) => list.map((item) => item.id);

test('order: priority first, then the given order; one per id; empty text and extra actions dropped', () => {
  assert.deepEqual(ids(orderNotices([notice('a', 1), notice('b', 5), notice('c', 3)])), ['b', 'c', 'a']);
  assert.deepEqual(ids(orderNotices([notice('first', 2), notice('second', 2), notice('first', 9, { text: '' })])), ['first', 'second']);
  const run = () => undefined;
  const [many] = orderNotices([notice('m', 1, { actions: [{ label: 'A', run }, { label: 'B', run }, { label: 'C', run }] })]);
  assert.deepEqual(many.actions?.map((action) => action.label), ['A', 'B']);
});

test('providers follow the signals they read and can be removed', () => {
  const offline = signal(false);
  const off = registerNotice(() => (offline.value ? notice('connection', NOTICE_PRIORITY.connection, { tone: 'error', text: 'Offline' }) : null));
  const offList = registerNotice(() => [notice('voice:a', NOTICE_PRIORITY.voice), notice('voice:b', NOTICE_PRIORITY.voice)]);
  registerNotice(() => { throw new Error('broken provider'); });
  assert.deepEqual(ids(visibleNotices.value), ['voice:a', 'voice:b']);
  offline.value = true;
  assert.deepEqual(ids(visibleNotices.value), ['connection', 'voice:a', 'voice:b']);
  off();
  offList();
  assert.deepEqual(ids(visibleNotices.value), []);
});

test('the connection line: nothing while connected or still starting; Reconnecting…, Offline or the load error', () => {
  assert.equal(connectionNotice({ status: 'open', loaded: true, loadError: null }), null);
  assert.equal(connectionNotice({ status: 'connecting', loaded: false, loadError: null }), null);
  assert.equal(connectionNotice({ status: 'connecting', loaded: true, loadError: null })?.text, 'Reconnecting…');
  assert.equal(connectionNotice({ status: 'closed', loaded: false, loadError: null })?.text, 'Offline');
  assert.equal(connectionNotice({ status: 'open', loaded: true, loadError: 'Load failed' })?.tone, 'error');
});
