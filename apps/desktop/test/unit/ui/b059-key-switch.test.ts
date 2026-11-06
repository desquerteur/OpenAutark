// B-059 #73 (ui/settings/endpoint.ts keyStays, used by the connection form's Provider list): a typed API key stays
// only within one vendor (the same host, or Other to Other) and is cleared when the Provider switches to another
// vendor – an OpenAI key is never added as another vendor's account.
// Owns: nothing in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyStays } from '../../../src/ui/settings/endpoint.ts';

test('B-059 #73: switching to another vendor clears the key', () => {
  assert.equal(keyStays('openai', 'openrouter'), false, 'OpenAI key → OpenRouter');
  assert.equal(keyStays('deepseek', 'openai'), false, 'DeepSeek key → OpenAI');
  assert.equal(keyStays('openai', 'other'), false, 'a named vendor → Other: the key goes');
  assert.equal(keyStays('other', 'deepinfra'), false, 'Other → a named vendor: the key goes');
});

test('B-059 #73: the same vendor keeps the key; nothing chosen before keeps it', () => {
  assert.equal(keyStays('openai', 'openai'), true);
  assert.equal(keyStays('other', 'other'), true, 'a URL of one\'s own, whatever its protocol');
  assert.equal(keyStays('', 'openai'), true, 'no provider chosen before');
});
