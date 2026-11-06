// The feedback tour is the first-run layer's first step ('tour', before the AI and About-you cards). A new
// install starts there; the settings accept it; an install that is through ('done') stays through; "Set up
// team again" (reset) starts at the AI card, not at the tour; the UI's step order leads from the tour to the
// AI card without a "Step n of 2".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Onboarding } from '../../../src/runtime/onboarding/service.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { ONBOARDING_STEPS } from '../../../src/shared/model/system.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { CARDS, TOUR_STEP, firstRunShown, nextStep, previousStep, stepText } from '../../../src/ui/onboarding/first-run-model.ts';
import { agent, harness } from '../chat/harness.ts';

const env = { locale: 'en-US', timezone: 'UTC' };

function setup() {
  const h = harness();
  const settings = new SettingsStore({ db: h.db, bus: h.bus, clock: h.clock, env });
  Object.assign(h.services, { settings, accounts: { list: () => [], detect: async () => ({}) } });
  const services = h.services as RuntimeServices;
  return { ...h, settings, make: () => new Onboarding({ services: () => services }) };
}

test("a new install starts at 'tour'; the step list and the settings accept it", () => {
  for (const step of ['tour', 'ai', 'about', 'done'] as const) assert.ok(ONBOARDING_STEPS.includes(step), step);
  const h = setup();
  h.org.add(agent('ag_boss', 'Manager', { mode: 'manager', template: 'manager', createdAt: 1 }));
  h.make();
  assert.deepEqual(h.settings.get().onboarding, { completed: false, step: 'tour' });
  assert.equal(h.settings.update({ onboarding: { step: 'ai' } }).onboarding.step, 'ai', 'Continue / Skip');
  assert.equal(h.settings.update({ onboarding: { step: 'tour' } }).onboarding.step, 'tour', 'a stored tour step is valid');
});

test('an install that is through stays through; reset starts at the AI card, not at the tour', () => {
  const done = setup();
  done.settings.update({ onboarding: { completed: true, step: 'done' } });
  done.make();
  assert.deepEqual(done.settings.get().onboarding, { completed: true, step: 'done' }, 'already done: untouched');
  done.make().reset();
  assert.deepEqual(done.settings.get().onboarding, { completed: false, step: 'ai' }, '"Set up team again" goes to the AI card, not the tour');
});

test('UI step order: the tour leads to the AI card and shows no "Step n of 2"; the two cards follow', () => {
  const at = (step: typeof TOUR_STEP) => ({ onboarding: { completed: false, step } });
  assert.equal(TOUR_STEP, 'tour');
  assert.equal(firstRunShown(at('tour'), true, false), true, 'the layer shows during the tour');
  assert.equal(firstRunShown(at('tour'), false, false), false, 'never on another window');
  assert.equal(nextStep('tour'), 'ai');
  assert.equal(previousStep('ai'), 'ai', 'the AI card has no way back to the tour');
  assert.equal(stepText('tour'), '');
  assert.deepEqual(CARDS, ['ai', 'about']);
  assert.deepEqual([stepText('ai'), stepText('about')], ['Step 1 of 2', 'Step 2 of 2']);
});
