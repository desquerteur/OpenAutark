// The timeout decision text (runtime/tools/timeout.ts timeoutDecisionText), shared by shell commands and engine-native
// tools: B-072 (live 03.11.2026: an app timeout was read as the person's "no" and became a team rule) – an abort says that
// the app stopped the call for its time limit and that going on is fine; a wait says nothing of a stop.
// Owns: these assertions only. Never: runs a command or a model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_STOPPED, timeoutDecisionText } from '../../../src/runtime/tools/timeout.ts';

test('an abort names the app as the one who stopped the call; the reason and who decided follow', () => {
  const text = timeoutDecisionText({ tool: 'Bash', elapsedSeconds: 120 }, { action: 'abort', reason: 'The decision model chose to abort.', by: 'llm:codex:gpt-6-luna' });
  assert.equal(APP_STOPPED, 'The app stopped the running call for its time limit – nobody declined it.');
  assert.equal(text, `Subconscious timeout decision for Bash after 120s: abort the running call. ${APP_STOPPED} I check its effects and go on – other ways work too. The decision model chose to abort. (llm:codex:gpt-6-luna)`);
  assert.doesNotMatch(text, /user|rejected|declined by/i, 'nothing that reads as the person\'s no');
});

test('a wait says only how long', () => {
  const text = timeoutDecisionText({ tool: 'shell', elapsedSeconds: 60 }, { action: 'wait', seconds: 30, reason: 'Install is progressing' });
  assert.equal(text, 'Subconscious timeout decision for shell after 60s: wait another 30 seconds until the next timeout. Install is progressing');
});
