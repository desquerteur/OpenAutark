// RT5 UI texts: the model menu offers chat models only (no embedding/decision/media specialists).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isChatModel } from '../../../src/ui/lib/model-fit.ts';
import type { ModelInfo } from '../../../src/shared/model/providers.ts';

const model = (id: string, strengths: Record<string, number>, extra: Partial<ModelInfo> = {}) => ({ id, name: id, available: true, strengths, ...extra }) as ModelInfo;

test('chat models: specialists (chat prior ≤ −0.95, media functions) are not offered', () => {
  assert.equal(isChatModel(model('claude:claude-opus-5-5', { chat: 0.4 })), true);
  assert.equal(isChatModel(model('ollama:qwen3:8b', {})), true, 'no prior = neutral');
  assert.equal(isChatModel(model('ollama:bge-m3', { chat: -1 })), false, 'embedding model');
  assert.equal(isChatModel(model('ollama:nimble', { chat: -0.95, decision: 0.9 })), false, 'decision model');
  assert.equal(isChatModel(model('openai:gpt-image-2', { chat: 0.2 }, { functions: ['image'] })), false);
});
