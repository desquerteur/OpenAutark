// A skill shows its id in words (ui/team/agent-core-model.ts skillTitle).
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillTitle } from '../../../src/ui/team/agent-core-model.ts';

test('a skill shows its id in words', () => {
  assert.equal(skillTitle('task-ownership'), 'Task ownership');
  assert.equal(skillTitle('human-minimal-handoff'), 'Human minimal handoff');
  assert.equal(skillTitle('deploy'), 'Deploy');
  assert.equal(skillTitle('ai-providers'), 'AI providers');
  assert.equal(skillTitle('set-up-with-ai'), 'Set up with AI');
  assert.equal(skillTitle('email-triage'), 'Email triage', 'only the word itself');
});
