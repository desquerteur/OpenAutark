// B-051 L7: Home's "No AI is connected yet" line (src/ui/onboarding/ai-notice.ts) – after the first run, while
// no model can answer, Home's one notice band says so with [Connect] (Settings › Models); it goes as
// soon as a model can answer. Regression: setup could be finished with nothing that answers and nothing said so.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Account, ModelInfo } from '../../../src/shared/model/providers.ts';
import { AI_NOTICE_ID, AI_NOTICE_TEXT, aiNotice, type AiNoticeInput } from '../../../src/ui/onboarding/ai-notice.ts';
import { NOTICE_PRIORITY } from '../../../src/ui/shell/notices.ts';

const account = (extra: Partial<Account> = {}): Account => ({ id: 'acc', provider: 'codex', auth: 'cli', enabled: true, state: 'ok', priority: 0, ...extra }) as Account;
const model = (extra: Partial<ModelInfo> = {}): ModelInfo => ({ id: 'codex:m', provider: 'codex', model: 'm', name: 'M', available: true, strengths: {}, accounts: [], tier: 'small', ...extra }) as ModelInfo;
const input = (extra: Partial<AiNoticeInput> = {}): AiNoticeInput => ({
  onboarding: { completed: true, step: 'done' }, home: true, loaded: true, readable: true, models: [], accounts: [], ...extra,
});

test('after the first run with nothing that answers: one warn line on Home with Connect', () => {
  const opened: string[] = [];
  const notice = aiNotice(input({ accounts: [account({ state: 'needs_login' })] }), () => opened.push('models'));
  assert.equal(notice?.id, AI_NOTICE_ID);
  assert.equal(notice?.text, "No AI is connected yet – your team can't start.");
  assert.equal(AI_NOTICE_TEXT, notice?.text);
  assert.equal(notice?.tone, 'warn');
  assert.equal(notice?.priority, NOTICE_PRIORITY.setup);
  assert.equal(notice?.onDismiss, undefined, 'a status, not an offer to dismiss');
  assert.deepEqual(notice?.actions?.map((action) => action.label), ['Connect']);
  notice?.actions?.[0].run();
  assert.deepEqual(opened, ['models']);
});

test('gone as soon as a model can answer – a loaded model list or, before it, an account that serves one', () => {
  assert.equal(aiNotice(input({ models: [model()] }), () => undefined), null);
  assert.equal(aiNotice(input({ accounts: [account({ state: 'cooling' })] }), () => undefined), null);
  assert.notEqual(aiNotice(input({ models: [model({ available: false })], accounts: [account()] }), () => undefined), null, 'a loaded list decides');
});

test('only on Home, after the snapshots, after the first run, where the accounts can be read', () => {
  assert.equal(aiNotice(input({ home: false }), () => undefined), null, 'away from Home');
  assert.equal(aiNotice(input({ loaded: false }), () => undefined), null, 'before the snapshots: not "nothing connected"');
  assert.equal(aiNotice(input({ readable: false }), () => undefined), null, 'a phone that may not read the accounts');
  assert.equal(aiNotice(input({ onboarding: { completed: false, step: 'ai' } }), () => undefined), null, 'the first run shows its own card');
  assert.equal(aiNotice(input({ onboarding: undefined }), () => undefined), null, 'settings not loaded');
  assert.notEqual(aiNotice(input({ onboarding: { completed: false, step: 'done' } }), () => undefined), null, 'the cards are through');
});

test('registered once by the status line; Connect leads to Settings › Models', () => {
  const ui = path.resolve(import.meta.dirname, '..', '..', '..', 'src', 'ui');
  const sources = readFileSync(path.join(ui, 'shell', 'StatusLine.tsx'), 'utf8');
  assert.equal(sources.match(/registerAiNotice\(\)/g)?.length, 1);
  assert.match(readFileSync(path.join(ui, 'onboarding', 'ai-notice.ts'), 'utf8'), /navigate\(\{ view: 'settings', section: 'models' \}\)/);
});
