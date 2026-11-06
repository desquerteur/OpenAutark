// B-041 My day: the settings sections `day` (working hours, buffer, morning plan, AI helps, keep awake, agents'
// lane) and `calendar` (the person's Google OAuth client – the secret only as a vault id): defaults, merge and
// persistence in settings.json (the whole section), the value rules (HH:MM, start before end, buffer 0–60, booleans), unknown keys refused, a damaged
// stored row falling back to the defaults, daySettingsOf for settings stored before the section existed, and the
// one "since last evening" rule (lastEvening) the runtime and Home share.
// Owns: checks of these two sections only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { parseText } from '../../../src/runtime/settings/schema.ts';
import { DAY_BOUNDARY_HOUR, DEFAULT_DAY_SETTINGS, clockMinutes, daySettingsOf, lastEvening } from '../../../src/shared/model/day-settings.ts';
import { lastEvening as runtimeLastEvening } from '../../../src/runtime/day/clock.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { clock, memoryDb, recordingBus, tempDir } from '../store/helpers.ts';

const env = { locale: 'de-DE', timezone: 'Europe/Berlin' };

function setup() {
  const db = memoryDb();
  const recorder = recordingBus();
  return { db, settings: new SettingsStore({ db, bus: recorder.bus, clock: clock(), env }), ...recorder };
}

const refused = (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request';

test('defaults: 08:00–20:00, 10 min buffer, plan at 06:00, AI helps and keep awake on, agents\' lane off; no calendar section', () => {
  const { settings } = setup();
  assert.deepEqual(settings.get().day, { workStart: '08:00', workEnd: '20:00', bufferMin: 10, autoPlan: true, planAt: '06:00', aiHelps: true, keepAwake: true, agentLane: false });
  assert.deepEqual(settings.get().day, { ...DEFAULT_DAY_SETTINGS });
  assert.equal(settings.get().calendar, undefined);
  assert.equal(DAY_BOUNDARY_HOUR, 4);
});

test('a patch merges into the day section, is stored in settings.json and survives a restart', (t) => {
  const temp = tempDir('wf-day-');
  t.after(temp.cleanup);
  const recorder = recordingBus();
  const settings = new SettingsStore({ bus: recorder.bus, clock: clock(), env, dataDir: temp.dir });
  const next = settings.update({ day: { workStart: '07:30', bufferMin: 0, agentLane: true } });
  assert.deepEqual(next.day, { ...DEFAULT_DAY_SETTINGS, workStart: '07:30', bufferMin: 0, agentLane: true });
  assert.equal(recorder.of('settings.updated').length, 1);
  assert.deepEqual(parseText(readFileSync(path.join(temp.dir, 'settings.json'), 'utf8')).data?.day, next.day, 'the whole section, as it applies');
  assert.deepEqual(new SettingsStore({ bus: recordingBus().bus, clock: clock(), env, dataDir: temp.dir }).get().day, next.day);
});

test('the value rules: HH:MM, the work start before its end, a buffer of 0–60 whole minutes, booleans, known keys', () => {
  const { settings, of } = setup();
  for (const day of [
    { workStart: '8:00' }, { workEnd: '24:00' }, { planAt: '06:60' }, { workStart: '20:00' }, { workEnd: '08:00' },
    { bufferMin: 61 }, { bufferMin: -1 }, { bufferMin: 2.5 }, { autoPlan: 'yes' }, { aiHelps: 1 }, { keepAwake: null, agentLane: 'no' }, { colour: 'red' },
  ]) {
    assert.throws(() => settings.update({ day: day as never }), refused, JSON.stringify(day));
  }
  assert.deepEqual(settings.get().day, { ...DEFAULT_DAY_SETTINGS }, 'a refused patch changes nothing');
  assert.equal(of('settings.updated').length, 0);
  assert.equal(settings.update({ day: { workStart: '06:00', workEnd: '23:59', bufferMin: 60 } }).day?.bufferMin, 60);
});

test('calendar: a Google client id and a vault id for its secret; anything else is refused', () => {
  const { settings } = setup();
  const next = settings.update({ calendar: { googleClientId: '1234-abc.apps.googleusercontent.com', googleSecretId: 'sec_01jab3k9z7mx2c4q' } });
  assert.deepEqual(next.calendar, { googleClientId: '1234-abc.apps.googleusercontent.com', googleSecretId: 'sec_01jab3k9z7mx2c4q' });
  for (const calendar of [{ googleClientId: 'has spaces' }, { googleClientId: 42 }, { googleSecretId: 'x'.repeat(81) }, { clientSecret: 'plain' }]) {
    assert.throws(() => settings.update({ calendar: calendar as never }), refused, JSON.stringify(calendar));
  }
  assert.equal(settings.update({ calendar: { googleSecretId: null as never } }).calendar?.googleSecretId, undefined, 'null clears it');
});

test('a damaged stored day row falls back to the defaults and keeps the other sections', () => {
  const { db } = setup();
  db.run(`INSERT INTO settings (key, value, updated_at) VALUES ('day', '{"workStart": "late"}', 1), ('profile', '{"name": "Ana"}', 1)`);
  const s = new SettingsStore({ db, bus: recordingBus().bus, clock: clock(), env }).get();
  assert.deepEqual(s.day, { ...DEFAULT_DAY_SETTINGS });
  assert.equal(s.profile.name, 'Ana');
});

test('daySettingsOf fills keys missing in older settings; clockMinutes reads HH:MM', () => {
  assert.deepEqual(daySettingsOf(undefined), { ...DEFAULT_DAY_SETTINGS });
  assert.deepEqual(daySettingsOf({ day: { planAt: '05:15' } }), { ...DEFAULT_DAY_SETTINGS, planAt: '05:15' });
  assert.equal(clockMinutes('20:00'), 1200);
  assert.equal(clockMinutes('7:00'), undefined);
});

test('lastEvening: the end of the working hours of the evening before the person\'s day, across the 04:00 boundary and DST', () => {
  const at = (iso: string) => Date.parse(iso);
  const BERLIN = 'Europe/Berlin';
  assert.equal(lastEvening(at('2026-10-24T05:00:00Z'), BERLIN, '20:00'), at('2026-10-23T18:00:00Z'), '07:00 → yesterday 20:00');
  assert.equal(lastEvening(at('2026-10-24T23:00:00Z'), BERLIN, '20:00'), at('2026-10-23T18:00:00Z'), '01:00 still belongs to the day that just ended');
  assert.equal(lastEvening(at('2026-10-25T02:30:00Z'), BERLIN, '20:00'), at('2026-10-23T18:00:00Z'), '03:30 after the clocks went back');
  assert.equal(lastEvening(at('2026-10-26T06:00:00Z'), BERLIN, '18:30'), at('2026-10-25T17:30:00Z'), 'winter time: the person\'s workEnd');
  assert.equal(lastEvening(at('2026-10-26T06:00:00Z'), BERLIN), at('2026-10-25T19:00:00Z'), 'no workEnd: 20:00');
  assert.equal(lastEvening(at('2026-10-26T06:00:00Z'), 'America/New_York', 'late'), at('2026-10-25T00:00:00Z'), 'no valid time: 20:00; 02:00 there still belongs to the 25th');
  assert.equal(runtimeLastEvening, lastEvening, 'the runtime uses the shared rule');
});
