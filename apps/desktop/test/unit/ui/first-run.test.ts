// First-run layer, pure rules (src/ui/onboarding/first-run-model.ts): when the layer shows, the card order
// (AI, About you – no voice, team or permission card), whether any model can answer and the About card's
// profile write.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Account, ModelInfo } from '../../../src/shared/model/providers.ts';
import type { Settings } from '../../../src/shared/model/system.ts';
import {
  CARDS, firstRunShown, nextStep, noUsableModel, previousStep, profilePatch, stepText,
} from '../../../src/ui/onboarding/first-run-model.ts';

const account = (extra: Partial<Account> = {}): Account => ({ id: 'acc', provider: 'codex', auth: 'cli', enabled: true, state: 'ok', ...extra }) as Account;
const model = (extra: Partial<ModelInfo> = {}): ModelInfo => ({ id: 'codex:m', provider: 'codex', model: 'm', name: 'M', available: true, strengths: {}, accounts: [], tier: 'small', ...extra }) as ModelInfo;
const onboarding = (step: Settings['onboarding']['step']) => ({ onboarding: { completed: false, step } });

test('the layer shows on the owner\'s window until its step is done, never in a preview', () => {
  assert.equal(firstRunShown(onboarding('ai'), true, false), true);
  assert.equal(firstRunShown(onboarding('about'), true, false), true);
  assert.equal(firstRunShown(onboarding('done'), true, false), false);
  assert.equal(firstRunShown(onboarding('ai'), false, false), false, 'a phone or a person never sees it');
  assert.equal(firstRunShown(onboarding('ai'), true, true), false, 'a hidden preview page draws Home');
  assert.equal(firstRunShown(null, true, false), false, 'settings not loaded yet');
});

test('two cards in order – AI, About you; back stays at the first, the last leads to done', () => {
  assert.deepEqual(CARDS, ['ai', 'about']);
  assert.deepEqual([nextStep('ai'), nextStep('about'), nextStep('done')], ['about', 'done', 'done']);
  assert.deepEqual([previousStep('about'), previousStep('ai')], ['ai', 'ai']);
  assert.deepEqual([stepText('ai'), stepText('about')], ['Step 1 of 2', 'Step 2 of 2']);
});

test('About you writes the trimmed name and company, only what changed', () => {
  assert.deepEqual(profilePatch({ name: '', company: '' }, '  Ada ', ' Lovelace GmbH '), { name: 'Ada', company: 'Lovelace GmbH' });
  assert.deepEqual(profilePatch({ name: 'Ada', company: 'X' }, 'Ada', 'Y'), { company: 'Y' });
  assert.equal(profilePatch({ name: 'Ada', company: '' }, ' Ada', ''), undefined, 'nothing changed: no write');
  assert.equal(profilePatch(undefined, 'a'.repeat(300), '')?.name?.length, 120, 'within the setting\'s limit');
});

test('no usable model: a loaded list decides, else a connected account that can serve', () => {
  assert.equal(noUsableModel([model()], []), false);
  assert.equal(noUsableModel([model({ available: false })], [account()]), true, 'a loaded list decides');
  assert.equal(noUsableModel([model({ functions: ['stt'] })], [account()]), true, 'a speech specialist cannot answer');
  assert.equal(noUsableModel([model({ strengths: { chat: -1 } })], [account()]), true, 'nor a model never used for chat');
  assert.equal(noUsableModel([], []), true, 'nothing connected');
  assert.equal(noUsableModel([], [account({ state: 'cooling' })]), false, 'list not loaded yet: a connected account may serve');
  assert.equal(noUsableModel([], [
    account({ state: 'needs_login' }), account({ state: 'error' }), account({ enabled: false }),
  ]), true, 'signed out, broken and off serve no chat');
  assert.equal(noUsableModel([], [account({ provider: 'kimi-cli' })]), false, 'a plan CLI on the ACP engine runs turns like any other');
});

test('the first run has only the AI and About cards: the voice, team, key-dialog and setup-notice files are gone', () => {
  const root = path.resolve(import.meta.dirname, '..', '..', '..', 'src', 'ui', 'onboarding');
  for (const gone of ['TeamCard.tsx', 'KeyDialog.tsx', 'ModelRows.tsx', 'VoiceCard.tsx', 'voice-model.ts', 'setup-notice.ts']) assert.equal(existsSync(path.join(root, gone)), false, gone);
  assert.ok(existsSync(path.join(root, 'AboutCard.tsx')));
});
