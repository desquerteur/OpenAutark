// B-050 K6 round 3 (src/ui/chat/model-tag-view.ts): the model tag under a message – a person's message
// that asked for a model and an agent's that recommended one show its short name; Auto, an external author's meta, a status line and an unknown name show nothing;
// the tooltip says Suggested / Pinned and the effort; the model a message was written on (meta.model) is no tag.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageModelTag } from '../../../src/ui/chat/model-tag-view.ts';
import type { Message } from '../../../src/shared/model/chat.ts';

const names: Record<string, string> = { 'claude:claude-opus-5-5': 'Opus 5.5', 'codex:gpt-6.1-sol': 'GPT-6.1 Sol' };
const nameOf = (id: string) => names[id] ?? id.split(':').pop();
const message = (authorKind: Message['authorKind'], meta: Message['meta'], kind: Message['kind'] = 'text') => ({ authorKind, kind, meta });

test('a person\'s and an agent\'s message show the model they named; Auto, external authors and status lines show nothing', () => {
  assert.deepEqual(messageModelTag(message('human', { modelHint: { modelId: 'claude:claude-opus-5-5', effort: 'high' } }), nameOf),
    { name: 'Opus 5.5', pinned: false, title: 'Suggested: Opus 5.5 · High' });
  assert.deepEqual(messageModelTag(message('human', { modelHint: { modelId: 'claude:claude-opus-5-5', pinned: true } }), nameOf),
    { name: 'Opus 5.5', pinned: true, title: 'Pinned: Opus 5.5' });
  assert.deepEqual(messageModelTag(message('agent', { modelHint: { modelId: 'codex:gpt-6.1-sol' } }), nameOf),
    { name: 'GPT-6.1 Sol', pinned: false, title: 'Suggested: GPT-6.1 Sol' }, 'an agent\'s recommendation (chat.send model) shows under its message');
  assert.equal(messageModelTag(message('agent', { model: 'codex:gpt-6.1-sol' }), nameOf), undefined, 'the model it was written on is no tag');
  assert.equal(messageModelTag(message('human', { modelHint: { modelId: 'auto' } }), nameOf), undefined);
  assert.equal(messageModelTag(message('human', {}), nameOf), undefined);
  assert.equal(messageModelTag(message('external', { modelHint: { modelId: 'codex:gpt-6.1-sol' } }), nameOf), undefined, 'untrusted meta');
  assert.equal(messageModelTag(message('agent', { modelHint: { modelId: 'codex:gpt-6.1-sol' } }, 'status'), nameOf), undefined);
  assert.equal(messageModelTag(message('agent', { modelHint: { modelId: 'codex:gpt-6.1-sol' } }), () => undefined), undefined, 'no name, no tag');
});
