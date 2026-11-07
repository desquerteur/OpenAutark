// AF-002: the setup assistant's steps and the spotlight tour's saved state at the runtime. A new install starts at
// 'profile' with the tour not shown yet; the settings accept every step and the tour's state, step and hints and refuse
// anything else; an install that is through stays through; "Set up again" (reset) starts at 'profile' and leaves the
// tour's state alone (the assistant starts the tour only when it was not seen).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Onboarding } from '../../../src/runtime/onboarding/service.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { settingsText } from '../../../src/runtime/settings/schema.ts';
import { ONBOARDING_STEPS, TOUR_STATES } from '../../../src/shared/model/system.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { agent, harness } from '../chat/harness.ts';

const env = { locale: 'en-US', timezone: 'UTC' };

function setup() {
  const h = harness();
  const settings = new SettingsStore({ db: h.db, bus: h.bus, clock: h.clock, env });
  Object.assign(h.services, { settings, accounts: { list: () => [], detect: async () => ({}) } });
  const services = h.services as RuntimeServices;
  return { ...h, settings, make: () => new Onboarding({ services: () => services }) };
}

test("a new install starts at 'profile' with the tour not shown yet; every step is accepted", () => {
  const h = setup();
  h.org.add(agent('ag_boss', 'Manager', { mode: 'manager', template: 'manager', createdAt: 1 }));
  h.make();
  assert.deepEqual(h.settings.get().onboarding, { completed: false, step: 'profile', tour: 'new', tourStep: '', hints: [] });
  for (const step of ONBOARDING_STEPS) assert.equal(h.settings.update({ onboarding: { step } }).onboarding.step, step);
});

test('the tour\'s state, step and hints are saved and checked', () => {
  const h = setup();
  for (const tour of TOUR_STATES) assert.equal(h.settings.update({ onboarding: { tour } }).onboarding.tour, tour);
  assert.equal(h.settings.update({ onboarding: { tour: 'started', tourStep: 'composer-send' } }).onboarding.tourStep, 'composer-send');
  assert.deepEqual(h.settings.update({ onboarding: { hints: ['day', 'chat'] } }).onboarding.hints, ['day', 'chat'], 'a list replaces the old one');
  assert.throws(() => h.settings.update({ onboarding: { tour: 'halfway' as never } }), /onboarding\.tour/);
  assert.throws(() => h.settings.update({ onboarding: { tourStep: 'Not An Id!' } }), /onboarding\.tourStep/);
  assert.throws(() => h.settings.update({ onboarding: { hints: [''] } }), /onboarding\.hints/);
  assert.throws(() => h.settings.update({ onboarding: { hints: Array.from({ length: 41 }, (_, index) => `a${index}`) } }), /onboarding\.hints/);
  assert.deepEqual([h.settings.get().onboarding.tour, h.settings.get().onboarding.tourStep], ['started', 'composer-send'], 'a refused write changes nothing');
});

test('an install that is through stays through; reset starts at the first step and keeps the tour\'s state', () => {
  const done = setup();
  done.settings.update({ onboarding: { completed: true, step: 'done', tour: 'done' } });
  done.make();
  assert.equal(done.settings.get().onboarding.step, 'done', 'already done: untouched');
  done.make().reset();
  const after = done.settings.get().onboarding;
  assert.deepEqual([after.completed, after.step, after.tour], [false, 'profile', 'done']);
});

test('settings.json explains the tour keys with their options', () => {
  const h = setup();
  const text = settingsText(h.settings.get(), { language: 'en', timezone: 'UTC' });
  assert.match(text, /The app tour: new = not shown yet, started = stopped part way, done = seen to the end, skipped = closed with Skip/);
  assert.match(text, /"tour": "new"/);
  assert.match(text, /"hints": \[\]/);
});
