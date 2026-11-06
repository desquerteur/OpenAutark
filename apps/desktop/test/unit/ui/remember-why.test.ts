// "Remember why…" (ui/chat/remember.ts): only the caller's own finished text messages with words offer it, and the
// typed reason becomes one references.remember call that keeps the message as an example too.
// Owns: these assertions only. Never: renders the dialog or calls the runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offersRemember, rememberParams } from '../../../src/ui/chat/remember.ts';

const own = { authorKind: 'human', authorId: 'human', kind: 'text', state: 'final', body: 'Thanks, see you Friday.' } as const;

test('the person\'s own finished text message offers Remember why', () => {
  assert.equal(offersRemember(own, 'human'), true);
});

test('agents\' and colleagues\' messages, streaming or empty ones, and non-text kinds do not', () => {
  assert.equal(offersRemember({ ...own, authorKind: 'agent', authorId: 'ag_mara' }, 'human'), false);
  assert.equal(offersRemember({ ...own, authorId: 'per_anna' }, 'human'), false, 'a colleague\'s words');
  assert.equal(offersRemember({ ...own, state: 'streaming' }, 'human'), false);
  assert.equal(offersRemember({ ...own, state: 'failed' }, 'human'), false);
  assert.equal(offersRemember({ ...own, body: '  \n' }, 'human'), false);
  assert.equal(offersRemember({ ...own, kind: 'status' }, 'human'), false);
});

test('the reason is trimmed and the message is kept as an example with it', () => {
  assert.deepEqual(rememberParams('msg_1', '  Short, because she reads on her phone.  '), {
    messageId: 'msg_1', why: 'Short, because she reads on her phone.', whyKind: 'reason', keepExample: true,
  });
});
