// The first run's team card became "About you" (OnboardingStep 'about'). An install that stopped on the old
// team card has 'team' stored: it reads as 'about' – the rest of the onboarding section stays (a refused value
// would have reset the whole section to its defaults), and the first run goes on there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { ONBOARDING_STEPS } from '../../../src/shared/model/system.ts';
import { clock, memoryDb, recordingBus } from '../store/helpers.ts';

const env = { locale: 'en-US', timezone: 'UTC' };

test("a stored 'team' step reads as 'about'; completed and the other sections stay", () => {
  const db = memoryDb();
  db.run(`INSERT INTO settings (key, value, updated_at) VALUES ('onboarding', ?, 0)`, [JSON.stringify({ completed: true, step: 'team' })]);
  const settings = new SettingsStore({ db, bus: recordingBus().bus, clock: clock(), env });
  assert.deepEqual(settings.get().onboarding, { completed: true, step: 'about' });
  for (const step of ['tour', 'ai', 'about', 'done'] as const) assert.ok(ONBOARDING_STEPS.includes(step), step);
  assert.throws(() => settings.update({ onboarding: { step: 'start' as never } }), /onboarding\.step/);
});
