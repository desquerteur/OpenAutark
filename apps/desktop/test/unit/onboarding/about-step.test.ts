// AF-002: the setup assistant starts at 'profile' (About you). An install that stopped on a step of an older first run
// – the feedback tour ('tour'), the old About you ('about'), the team or voice card – has that stored: it reads as
// 'profile', the rest of the onboarding section stays (a refused value would have reset the whole section to its
// defaults), and the assistant goes on there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { ONBOARDING_STEPS } from '../../../src/shared/model/system.ts';
import { clock, memoryDb, recordingBus } from '../store/helpers.ts';

const env = { locale: 'en-US', timezone: 'UTC' };

for (const old of ['tour', 'about', 'team', 'voice']) {
  test(`a stored '${old}' step reads as 'profile'; completed and the other sections stay`, () => {
    const db = memoryDb();
    db.run(`INSERT INTO settings (key, value, updated_at) VALUES ('onboarding', ?, 0)`, [JSON.stringify({ completed: true, step: old })]);
    const settings = new SettingsStore({ db, bus: recordingBus().bus, clock: clock(), env });
    const { completed, step } = settings.get().onboarding;
    assert.deepEqual({ completed, step }, { completed: true, step: 'profile' });
  });
}

test('the step list is the assistant\'s four steps and done; anything else is refused', () => {
  assert.deepEqual(ONBOARDING_STEPS, ['profile', 'ai', 'connectors', 'agent', 'done']);
  const settings = new SettingsStore({ db: memoryDb(), bus: recordingBus().bus, clock: clock(), env });
  assert.throws(() => settings.update({ onboarding: { step: 'start' as never } }), /onboarding\.step/);
});
