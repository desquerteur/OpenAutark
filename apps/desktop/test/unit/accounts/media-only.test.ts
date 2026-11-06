// B-058 F0: ElevenLabs and fal.ai keys are media-only accounts – adding one saves the key and the check
// reads 'ok' without any engine (there is no chat engine for them); Groq is checked by the compatible engine.
// Owns: nothing in production. Never runs a real provider call (account harness).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

test('a media-only key account is ok after its check and runs no engine check', async () => {
  const h = harness();
  for (const provider of ['elevenlabs', 'fal'] as const) {
    const added = await h.service.add({ provider, apiKey: 'test-key-0123456789' });
    await h.settle();
    const checked = await h.service.check(added.id);
    assert.equal(checked.state, 'ok', provider);
    assert.equal(checked.label, provider === 'fal' ? 'fal.ai' : 'ElevenLabs');
    assert.ok(!h.checks.includes(added.id), `${provider}: no engine check`);
  }
  const groq = await h.service.add({ provider: 'groq', apiKey: 'test-key-0123456789' });
  await h.settle();
  assert.equal((await h.service.check(groq.id)).state, 'ok');
  assert.ok(h.checks.includes(groq.id), 'Groq: checked by its engine');
  await h.service.dispose();
});
