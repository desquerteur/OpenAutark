// Setup assistant, pure rules (src/ui/onboarding/first-run-model.ts, AF-002): when the layer shows, the step order
// (About you, AI, tools, first agent – no voice, team or permission card), each step's one sentence, whether any model
// can answer, the profile write with the language, and the language list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Account, ModelInfo } from '../../../src/shared/model/providers.ts';
import type { Settings } from '../../../src/shared/model/system.ts';
import {
  CARDS, FIRST_STEP, LAYER_VIEWS, STEP_INFO, cardOf, firstRunShown, languageOptions, nextStep, noUsableModel, previousStep, profilePatch, stepText,
} from '../../../src/ui/onboarding/first-run-model.ts';
import { sentences } from '../../../src/ui/tour/spotlight-model.ts';

const account = (extra: Partial<Account> = {}): Account => ({ id: 'acc', provider: 'codex', auth: 'cli', enabled: true, state: 'ok', ...extra }) as Account;
const model = (extra: Partial<ModelInfo> = {}): ModelInfo => ({ id: 'codex:m', provider: 'codex', model: 'm', name: 'M', available: true, strengths: {}, accounts: [], tier: 'small', ...extra }) as ModelInfo;
const onboarding = (step: Settings['onboarding']['step']) => ({ onboarding: { completed: false, step } });

test('the layer shows on the owner\'s window until its step is done, never in a preview', () => {
  assert.equal(firstRunShown(onboarding('profile'), true, false), true);
  assert.equal(firstRunShown(onboarding('agent'), true, false), true);
  assert.equal(firstRunShown(onboarding('done'), true, false), false);
  assert.equal(firstRunShown(onboarding('ai'), false, false), false, 'a phone or a person never sees it');
  assert.equal(firstRunShown(onboarding('ai'), true, true), false, 'a hidden preview page draws Home');
  assert.equal(firstRunShown(null, true, false), false, 'settings not loaded yet');
  assert.deepEqual(LAYER_VIEWS, ['home', 'day'], 'the rail\'s My day (#/day) shows the assistant too, not only #/home');
});

test('four steps in order – About you, AI, tools, first agent; back stays at the first, the last leads to done', () => {
  assert.deepEqual(CARDS, ['profile', 'ai', 'connectors', 'agent']);
  assert.equal(FIRST_STEP, 'profile');
  assert.deepEqual(CARDS.map((card) => nextStep(card)), ['ai', 'connectors', 'agent', 'done']);
  assert.equal(nextStep('done'), 'done');
  assert.deepEqual(CARDS.map((card) => previousStep(card)), ['profile', 'profile', 'ai', 'connectors']);
  assert.deepEqual(CARDS.map((card) => stepText(card)), ['Step 1 of 4', 'Step 2 of 4', 'Step 3 of 4', 'Step 4 of 4']);
  assert.equal(cardOf(undefined), 'profile');
  assert.equal(cardOf('done'), 'profile', 'an unknown or finished step shows the first card if the layer is ever drawn');
  assert.equal(cardOf('connectors'), 'connectors');
});

test('every step says in one sentence what it is for and has a title', () => {
  for (const card of CARDS) {
    const info = STEP_INFO[card];
    assert.ok(info.title.trim(), card);
    assert.equal(sentences(info.purpose), 1, `${card}: "${info.purpose}" is one sentence`);
    assert.ok(info.purpose.length <= 120, `${card}: short`);
  }
});

test('About you writes the trimmed name and company and the language, only what changed', () => {
  assert.deepEqual(profilePatch({ name: '', company: '' }, '  Ada ', ' Lovelace GmbH '), { name: 'Ada', company: 'Lovelace GmbH' });
  assert.deepEqual(profilePatch({ name: 'Ada', company: 'X' }, 'Ada', 'Y'), { company: 'Y' });
  assert.equal(profilePatch({ name: 'Ada', company: '' }, ' Ada', ''), undefined, 'nothing changed: no write');
  assert.equal(profilePatch(undefined, 'a'.repeat(300), '')?.name?.length, 120, 'within the setting\'s limit');
  assert.deepEqual(profilePatch({ name: 'Ada', company: '', language: 'en' }, 'Ada', '', 'de'), { language: 'de' });
  assert.equal(profilePatch({ name: 'Ada', company: '', language: 'de' }, 'Ada', '', 'de'), undefined, 'the same language: no write');
  assert.equal(profilePatch({ name: 'Ada', company: '', language: 'de' }, 'Ada', '', 'Deutsch!'), undefined, 'never a value the settings refuse');
});

test('the language list keeps the PC\'s own code selected, also a longer one', () => {
  assert.equal(languageOptions('de').selected, 'de');
  assert.equal(languageOptions('de').options.length, languageOptions('en').options.length, 'a known code adds no row');
  const swiss = languageOptions('de-CH');
  assert.equal(swiss.selected, 'de-CH');
  assert.deepEqual(swiss.options[0], { code: 'de-CH', name: 'Deutsch (de-CH)' });
  assert.equal(languageOptions(undefined).selected, 'en');
  assert.equal(languageOptions('sw').options[0].name, 'sw', 'an unlisted language keeps its code');
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

test('the assistant\'s cards are the four step files; the voice, team, key-dialog, About and setup-notice files are gone', () => {
  const root = path.resolve(import.meta.dirname, '..', '..', '..', 'src', 'ui', 'onboarding');
  for (const gone of ['TeamCard.tsx', 'KeyDialog.tsx', 'ModelRows.tsx', 'VoiceCard.tsx', 'voice-model.ts', 'setup-notice.ts', 'AboutCard.tsx']) assert.equal(existsSync(path.join(root, gone)), false, gone);
  for (const card of ['ProfileCard.tsx', 'AiCard.tsx', 'ConnectorsCard.tsx', 'AgentCard.tsx']) assert.ok(existsSync(path.join(root, card)), card);
});
