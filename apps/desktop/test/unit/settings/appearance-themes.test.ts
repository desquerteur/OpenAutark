// AF-008: settings.json › appearance – the person's own themes, the one in use, the panels a new tab offers.
// - save and load: themes, the chosen theme and the panel order land in settings.json and survive a restart; a wrong
//   theme keeps the last good section (with the reason in the file);
// - a theme's CSS: only what it changes, the light and dark backgrounds per scheme (System follows the PC), the accent
//   with a readable text colour, radii, density and text size; Autark's own look writes nothing;
// - the theme file: export → import gives the same theme with a fresh id; anything else is refused with a reason;
// - forgiving reads: an unknown or doubled panel is dropped, a missing one joins at the end.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { parseText } from '../../../src/runtime/settings/schema.ts';
import { RootWatcher } from '../../../src/runtime/root/watcher.ts';
import { ROOT_SETTINGS } from '../../../src/runtime/root/layout.ts';
import { DEFAULT_PANELS, appearanceOf, panelOrderOf } from '../../../src/shared/model/appearance.ts';
import {
  AUTARK_LOOK, THEME_PRESETS, contrastRatio, exportTheme, importTheme, readableOn, themeCss, themeFileName, themeIdFor, themeOf, themesProblem,
  type CustomTheme,
} from '../../../src/shared/model/themes.ts';
import { clock, memoryDb, recordingBus, tempDir } from '../store/helpers.ts';

const env = { locale: 'en-US', timezone: 'Europe/Berlin' };
const ocean: CustomTheme = { id: 'ocean-blue', name: 'Ocean blue', accent: '#1f6fd1', background: '#f6f9fd', backgroundDark: '#1d2430', font: 'Georgia', textSize: 110, density: 'compact', radius: 4 };

function setup() {
  const temp = tempDir('wf-appearance-themes-');
  const db = memoryDb();
  const file = path.join(temp.dir, ROOT_SETTINGS);
  const recorder = recordingBus();
  const time = clock();
  const root = new RootWatcher({ root: temp.dir, clock: time, watch: false, debounceMs: 1, maxWaitMs: 5 });
  root.start();
  const make = () => new SettingsStore({ db, bus: recorder.bus, clock: time, env, dataDir: temp.dir, root });
  const settings = make();
  const json = () => parseText(readFileSync(file, 'utf8')).data as Record<string, Record<string, unknown>>;
  const done = () => { settings.close(); root.stop(); temp.cleanup(); };
  return { settings, make, json, done };
}

test('a fresh install uses Autark\'s own look and the panels in their first order', () => {
  const { settings, json, done } = setup();
  try {
    const look = settings.get().appearance!;
    assert.equal(look.theme, '');
    assert.deepEqual(look.themes, []);
    assert.deepEqual(look.panels, DEFAULT_PANELS);
    assert.deepEqual(look.hiddenPanels, []);
    assert.deepEqual(json().appearance.panels, DEFAULT_PANELS, 'written into settings.json');
  } finally { done(); }
});

test('own themes, the chosen one and the panel order are saved and loaded', () => {
  const { settings, make, json, done } = setup();
  try {
    settings.update({ appearance: { themes: [ocean], theme: 'ocean-blue', panels: ['files', 'notes', 'day', 'work', 'media', 'agents'], hiddenPanels: ['work'] } });
    assert.deepEqual(json().appearance.themes, [ocean], 'in the file');
    settings.close();
    const again = make();
    const look = again.get().appearance!;
    assert.deepEqual(look.themes, [ocean], 'after a restart');
    assert.equal(look.theme, 'ocean-blue');
    assert.deepEqual(look.panels, ['files', 'notes', 'day', 'work', 'media', 'agents']);
    assert.deepEqual(look.hiddenPanels, ['work']);
    again.close();
  } finally { done(); }
});

test('wrong themes and panels are refused, naming the key', () => {
  const { settings, done } = setup();
  try {
    assert.throws(() => settings.update({ appearance: { themes: [{ ...ocean, accent: 'blue' }] } }), /appearance\.themes\[0\]\.accent/);
    assert.throws(() => settings.update({ appearance: { themes: [{ ...ocean, font: 'x"; } body { display: none' }] } }), /appearance\.themes\[0\]\.font/);
    assert.throws(() => settings.update({ appearance: { themes: [ocean, { ...ocean }] } }), /appearance\.themes\[1\]\.id/);
    assert.throws(() => settings.update({ appearance: { themes: [{ ...ocean, textSize: 300 }] } }), /appearance\.themes\[0\]\.textSize/);
    assert.throws(() => settings.update({ appearance: { theme: 'nope' } }), /appearance\.theme/, 'a theme that is not in the list');
    assert.throws(() => settings.update({ appearance: { panels: ['day', 'day', 'work', 'notes', 'media', 'files', 'agents'] } }), /appearance\.panels/);
    assert.throws(() => settings.update({ appearance: { hiddenPanels: ['browser' as never] } }), /appearance\.hiddenPanels/);
    assert.equal(settings.get().appearance?.theme, '', 'nothing applied');
  } finally { done(); }
});

test('a theme\'s CSS: only what it changes, per scheme, with readable accent text', () => {
  assert.equal(themeCss(AUTARK_LOOK), '', 'Autark\'s own look writes nothing');
  const css = themeCss(ocean);
  assert.match(css, /:root \{[^}]*--accent: #1f6fd1;[^}]*--accent-fg: #ffffff;[^}]*--focus: #1f6fd1/s);
  assert.match(css, /--font: "Georgia", "Segoe UI"/);
  assert.match(css, /--r-md: 4px;/);
  assert.match(css, /--r-composer: 8px;/);
  assert.match(css, /--row-h: 48px;/);
  assert.match(css, /--text-zoom: 1\.1/);
  assert.match(css, /:root\[data-theme=light\] \{\s*--surface: #f6f9fd;/);
  assert.match(css, /@media \(prefers-color-scheme: light\) \{\s*:root\[data-theme=system\] \{\s*--surface: #f6f9fd;/);
  assert.match(css, /:root\[data-theme=dark\] \{\s*--surface: #1d2430;/);
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*:root\[data-theme=system\] \{\s*--surface: #1d2430;/);
  assert.doesNotMatch(themeCss({ ...ocean, backgroundDark: '' }), /data-theme=dark/, 'no dark background: the dark scheme stays Autark\'s');
  const preview = themeCss(ocean, '.preview-dark', 'dark');
  assert.match(preview, /^\.preview-dark \{/);
  assert.match(preview, /--surface: #1d2430/);
  assert.doesNotMatch(preview, /#f6f9fd/);
  assert.equal(readableOn('#ffd400'), '#111111', 'dark text on yellow');
  assert.equal(readableOn('#1f6fd1'), '#ffffff', 'white text on blue');
  assert.ok(contrastRatio('#ffffff', '#000000') > 20.9);
  assert.ok(Math.abs(contrastRatio('#777777', '#777777') - 1) < 1e-9);
});

test('the theme file: export and import give the same theme with a new id; anything else is refused', () => {
  const text = exportTheme(ocean);
  assert.equal(JSON.parse(text).autarkTheme, 1);
  assert.equal(JSON.parse(text).id, undefined, 'no id in the file');
  assert.equal(themeFileName(ocean), 'ocean-blue.autark-theme.json');
  const back = importTheme(text, ['ocean-blue']);
  assert.deepEqual({ ...back, id: '' }, { ...ocean, id: '' });
  assert.equal(back.id, 'ocean-blue-2', 'an id no theme has yet');
  assert.throws(() => importTheme('not json'), /not a theme/);
  assert.throws(() => importTheme('{"name":"x"}'), /not an Autark theme/);
  assert.throws(() => importTheme('{"autarkTheme":1,"name":"  "}'), /no name/);
  const forgiving = importTheme(JSON.stringify({ autarkTheme: 1, name: 'Loud', accent: 'red', textSize: 999, density: 'tight', font: 'a;b' }));
  assert.deepEqual(forgiving, { id: 'loud', name: 'Loud', ...AUTARK_LOOK, textSize: 130 }, 'unusable values take Autark\'s own, sizes are clamped');
  assert.equal(themeIdFor('Mein Thema Ü!', ['mein-thema-u']), 'mein-thema-u-2');
  assert.equal(themeOf({ name: '' }), undefined);
  for (const preset of THEME_PRESETS) assert.equal(themesProblem([preset]), undefined, `${preset.name} is a valid theme`);
});

test('forgiving reads of the panels and the section', () => {
  assert.deepEqual(panelOrderOf(['notes', 'nope', 'notes', 'day']), ['notes', 'day', 'work', 'media', 'files', 'agents'], 'unknown and doubled dropped, the rest at the end');
  assert.deepEqual(panelOrderOf(undefined), DEFAULT_PANELS);
  const look = appearanceOf({ theme: 'gone', themes: [ocean, { name: '' }], hiddenPanels: ['work', 'x'] });
  assert.equal(look.theme, '', 'a theme no longer in the list: Autark\'s own');
  assert.deepEqual(look.themes, [ocean]);
  assert.deepEqual(look.hiddenPanels, ['work']);
});
