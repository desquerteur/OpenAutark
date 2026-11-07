// SettingsStore without a data folder (memory only) and its value rules: defaults, deep merge, null clears,
// validation refuses a patch without writing, a damaged old row falls back to the defaults, copies out.
// The file side is test/unit/settings/file.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { defaultSettings, languageOf } from '../../../src/runtime/settings/defaults.ts';
import { deepMerge } from '../../../src/runtime/settings/validate.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { clock, memoryDb, recordingBus } from '../store/helpers.ts';

const env = { locale: 'de-DE', timezone: 'Europe/Berlin' };

function setup() {
  const db = memoryDb();
  const recorder = recordingBus();
  const settings = new SettingsStore({ db, bus: recorder.bus, clock: clock(), env });
  return { db, settings, ...recorder };
}

test('defaults cover the full Settings shape with the confirmed values', () => {
  const s = setup().settings.get();
  assert.equal(s.voice.realtime, 'off');
  assert.equal(s.onboarding.step, 'profile'); // AF-002: a new install starts with the setup assistant
  assert.deepEqual([s.onboarding.tour, s.onboarding.tourStep, s.onboarding.hints], ['new', '', []]); // AF-002: the tour not shown yet
  assert.equal(s.routing.work, 'auto');
  assert.equal(s.profile.timezone, 'Europe/Berlin');
  assert.equal(s.profile.language, 'de');
  assert.deepEqual(s.notifications.pushFor, ['todo', 'blocker', 'important']);
  assert.equal(s.preferences.sidebarWidth, 288);
  assert.equal(s.preferences.closeToTray, true);
  assert.deepEqual(Object.keys(s).sort(), ['appearance', 'day', 'devices', 'feedback', 'library', 'notifications', 'onboarding', 'personality', 'preferences', 'profile', 'pwa', 'routing', 'voice']); // day: B-041 My day; library: B-078; personality: AF-006; appearance: AF-010/AF-008
  assert.deepEqual(s.voice.vocabulary, []);
});

test('the speech word list is plain words; term objects of an older file read as their term', () => {
  const { settings } = setup();
  assert.deepEqual(settings.update({ voice: { vocabulary: ['Kimi', 'Teydra'] } }).voice.vocabulary, ['Kimi', 'Teydra']);
  const old = [{ term: 'Kimi', soundsLike: ['Kimmy'] }] as never;
  assert.deepEqual(settings.update({ voice: { vocabulary: old } }).voice.vocabulary, ['Kimi']);
  assert.throws(() => settings.update({ voice: { vocabulary: ['x'.repeat(121)] } }), /voice\.vocabulary/);
});

test('language and timezone come from the OS when not given', () => {
  const s = defaultSettings();
  assert.match(s.profile.language, /^[a-z]{2,3}$/);
  assert.ok(s.profile.timezone.length > 0);
  assert.equal(languageOf('en-US'), 'en');
  assert.equal(languageOf('pt_BR'), 'pt');
  assert.equal(languageOf('!!'), 'en');
});

test('update deep-merges and emits settings.updated; without a data folder nothing is written to the database', () => {
  const { db, settings, of } = setup();
  const next = settings.update({ preferences: { sidebarWidth: 300 } });
  assert.equal(next.preferences.sidebarWidth, 300);
  assert.equal(next.preferences.theme, 'system');
  assert.equal(of('settings.updated').length, 1);
  assert.deepEqual(settings.get(), next);
  assert.deepEqual(db.all('SELECT key FROM settings'), []);
});

test('null clears optional keys; arrays replace', () => {
  const { settings } = setup();
  settings.update({ notifications: { quietHours: { from: '22:00', to: '07:00' }, pushFor: ['todo'] } });
  assert.deepEqual(settings.get().notifications.quietHours, { from: '22:00', to: '07:00' });
  assert.deepEqual(settings.get().notifications.pushFor, ['todo']);
  settings.update({ notifications: { quietHours: null as never } });
  assert.equal(settings.get().notifications.quietHours, undefined);
});

test('B-044: preferences.suggestChanges is gone (the X04 suggestions were removed) – a patch naming it is refused', () => {
  const { settings } = setup();
  assert.equal('suggestChanges' in settings.get().preferences, false);
  assert.throws(() => settings.update({ preferences: { suggestChanges: false } as never }), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');
});

test('validation rejects out-of-range values and unknown keys without writing', () => {
  const { settings, of } = setup();
  const rejects = (patch: unknown) => assert.throws(() => settings.update(patch as never), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');
  rejects({ preferences: { sidebarWidth: 199 } });
  rejects({ preferences: { sidebarWidth: 421 } });
  rejects({ preferences: { sidebarWidth: 300.5 } });
  rejects({ preferences: { colour: 'red' } });
  rejects({ nope: {} });
  rejects({ profile: { timezone: 'Mars/Base' } });
  rejects({ notifications: { quietHours: { from: '25:00', to: '07:00' } } });
  rejects({ notifications: { pushFor: ['spam'] } });
  rejects({ permissions: { mode: 'autonomous' } }); // the section is gone
  rejects({ feedback: { repo: 'not a repo' } });
  assert.equal(settings.get().preferences.sidebarWidth, 288);
  assert.equal(of('settings.updated').length, 0);
  settings.update({ preferences: { sidebarWidth: 200 } });
  settings.update({ preferences: { sidebarWidth: 420 } });
  assert.equal(settings.get().preferences.sidebarWidth, 420);
});

test('a damaged old row falls back to the defaults instead of failing', () => {
  const { db } = setup();
  db.run(`INSERT INTO settings (key, value, updated_at) VALUES ('preferences', '{"sidebarWidth": 9999}', 1), ('profile', '{"name": "Ana"}', 1)`);
  const s = new SettingsStore({ db, bus: recordingBus().bus, clock: clock(), env }).get();
  assert.equal(s.preferences.sidebarWidth, 288);
  assert.equal(s.profile.name, 'Ana');
});

test('get returns copies; deepMerge ignores prototype keys', () => {
  const { settings } = setup();
  settings.get().profile.name = 'mutated';
  assert.equal(settings.get().profile.name, '');
  const merged = deepMerge({ a: 1 }, JSON.parse('{"__proto__": {"polluted": true}, "b": 2}')) as Record<string, unknown>;
  assert.equal(merged.b, 2);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('a first run stopped on a card of an older first run (tour, about, team, voice) reads as profile (AF-002)', () => {
  for (const step of ['tour', 'about', 'team', 'voice']) {
    const { db } = setup();
    db.run(`INSERT INTO settings (key, value, updated_at) VALUES ('onboarding', ?, 1)`, [JSON.stringify({ completed: false, step })]);
    assert.equal(new SettingsStore({ db, bus: recordingBus().bus, clock: clock(), env }).get().onboarding.step, 'profile', step);
  }
});
