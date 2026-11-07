// AF-002: the spotlight tour's pure rules (src/ui/tour/spotlight-model.ts) and its step list (spotlight-steps.ts):
// the order forward and back, steps whose target is missing are skipped and never end the tour, the progress counts
// only steps that are there, where a tour left part way goes on, what is saved, which first-visit hint is due, and
// that every step is short, unique and hangs on the agreed data-tour names.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Settings } from '../../../src/shared/model/system.ts';
import {
  canGoBack, centred, dueHint, findStep, hintsAllowed, progress, progressLabel, progressText, resumeDue, resumeIndex,
  sentences, tourPatch, withHints, type AreaHint, type TourStepDef,
} from '../../../src/ui/tour/spotlight-model.ts';
import { AREA_HINTS, TOUR_NAMES, TOUR_STEPS } from '../../../src/ui/tour/spotlight-steps.ts';

const step = (id: string, targets: string[] = [`[data-tour="${id}"]`]): TourStepDef => ({ id, targets, title: id, text: `${id}.` });
const STEPS = [step('welcome', []), step('a'), step('b'), step('c'), step('end', [])];
const present = (ids: string[]) => (candidate: TourStepDef) => ids.includes(candidate.id);
const onboarding = (extra: Partial<Settings['onboarding']>): Settings['onboarding'] => ({ completed: true, step: 'done', ...extra });

test('forward and back go to the next step that can be shown; centred steps always can', () => {
  const all = present(['a', 'b', 'c']);
  assert.equal(findStep(STEPS, -1, 1, all), 0, 'the start: the centred welcome');
  assert.equal(findStep(STEPS, 0, 1, all), 1);
  assert.equal(findStep(STEPS, 3, 1, all), 4, 'the end is centred');
  assert.equal(findStep(STEPS, 4, 1, all), -1, 'past the last: the tour is through');
  assert.equal(findStep(STEPS, 2, -1, all), 1);
  assert.equal(findStep(STEPS, 0, -1, all), -1, 'nothing before the first');
  assert.equal(centred(STEPS[0]), true);
  assert.equal(centred(STEPS[1]), false);
});

test('a missing target is skipped silently in both directions and never ends the tour', () => {
  const onlyC = present(['c']);
  assert.equal(findStep(STEPS, 0, 1, onlyC), 3, 'a and b are not there: straight to c');
  assert.equal(findStep(STEPS, 3, -1, onlyC), 0, 'back over them to the welcome');
  const none = present([]);
  assert.equal(findStep(STEPS, 0, 1, none), 4, 'with no target at all the tour still reaches its end');
  assert.equal(findStep(STEPS, 0, 1, present(['a', 'b', 'c']), new Set(['a'])), 2, 'a step known missing is not tried again');
});

test('the progress counts the steps that are there; the total shrinks once one is missing', () => {
  assert.deepEqual(progress(STEPS, 0, new Set()), { position: 1, total: 5 });
  assert.deepEqual(progress(STEPS, 3, new Set()), { position: 4, total: 5 });
  assert.deepEqual(progress(STEPS, 3, new Set(['a', 'b'])), { position: 2, total: 3 }, '3 of 5 minus the two missing');
  assert.deepEqual(progress(STEPS, 4, new Set(['a', 'b', 'c'])), { position: 2, total: 2 });
  assert.equal(progressText({ position: 3, total: 12 }), '3 / 12');
  assert.equal(progressLabel({ position: 3, total: 12 }), 'Step 3 of 12');
  assert.equal(canGoBack(STEPS, 0, new Set()), false, 'the first step has no Back');
  assert.equal(canGoBack(STEPS, 3, new Set(['a', 'b'])), true, 'the welcome is still before it');
  assert.equal(canGoBack(STEPS, 1, new Set(['welcome'])), false);
});

test('a tour left part way goes on at its saved step; a new, finished or closed one starts at the first', () => {
  assert.equal(resumeIndex(STEPS, onboarding({ tour: 'started', tourStep: 'b' }), true), 2);
  assert.equal(resumeIndex(STEPS, onboarding({ tour: 'started', tourStep: 'b' }), false), 0, 'Show the tour again starts at the beginning');
  assert.equal(resumeIndex(STEPS, onboarding({ tour: 'started', tourStep: 'gone' }), true), 0, 'a step that no longer exists');
  assert.equal(resumeIndex(STEPS, onboarding({ tour: 'skipped', tourStep: 'b' }), true), 0);
  assert.equal(resumeIndex(STEPS, undefined, true), 0);
  assert.equal(resumeDue(onboarding({ tour: 'started' })), true, 'the window closed during the tour: it goes on by itself');
  assert.equal(resumeDue(onboarding({ tour: 'new' })), false, 'a new tour waits for the setup assistant or the button');
  assert.equal(resumeDue({ completed: false, step: 'ai', tour: 'started' }), false, 'never during the setup assistant');
});

test('what the tour saves: started at a step, done, skipped', () => {
  assert.deepEqual(tourPatch({ kind: 'step', id: 'b' }), { tour: 'started', tourStep: 'b' });
  assert.deepEqual(tourPatch({ kind: 'done' }), { tour: 'done', tourStep: '' });
  assert.deepEqual(tourPatch({ kind: 'skip' }), { tour: 'skipped', tourStep: '' });
  assert.deepEqual(withHints(['day'], ['chat', undefined, 'day']), ['day', 'chat'], 'new areas added once, in order');
  assert.equal(withHints(['day'], ['day', undefined]), undefined, 'nothing new: no write');
  assert.deepEqual(withHints(undefined, ['a', 'b', 'c'], 2), ['b', 'c'], 'kept within the limit');
});

test('first-visit hints: only after the tour was closed or finished, once per area, for the area on screen', () => {
  const hints: AreaHint[] = [
    { area: 'day', views: ['day', 'home'], step: step('hint-day') },
    { area: 'models', views: ['settings'], page: 'models', step: step('hint-models') },
    { area: 'pane', views: 'pane', step: step('hint-pane') },
  ];
  assert.equal(hintsAllowed(onboarding({ tour: 'skipped' })), true);
  assert.equal(hintsAllowed(onboarding({ tour: 'done' })), true, 'for the areas the tour did not reach');
  assert.equal(hintsAllowed(onboarding({ tour: 'new' })), false, 'an install from before the tour knows the app');
  assert.equal(hintsAllowed(onboarding({ tour: 'started' })), false, 'not while a tour is left part way');
  assert.equal(hintsAllowed({ completed: false, step: 'profile', tour: 'skipped' }), false, 'never during the setup assistant');
  assert.equal(dueHint(hints, 'home', undefined, false, [])?.area, 'day');
  assert.equal(dueHint(hints, 'home', undefined, false, ['day']), undefined, 'shown once');
  assert.equal(dueHint(hints, 'settings', 'general', false, []), undefined, 'another page');
  assert.equal(dueHint(hints, 'settings', 'models', false, [])?.area, 'models');
  assert.equal(dueHint(hints, 'chat', undefined, true, [])?.area, 'pane', 'the side pane opened');
  assert.equal(dueHint(hints, 'chat', undefined, false, []), undefined);
});

test('the app tour: unique ids, one or two short sentences per step, a welcome and an end in the middle', () => {
  const ids = TOUR_STEPS.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  assert.equal(TOUR_STEPS[0].id, 'welcome');
  assert.equal(TOUR_STEPS.at(-1)?.id, 'end');
  assert.ok(centred(TOUR_STEPS[0]) && centred(TOUR_STEPS.at(-1)!));
  for (const entry of [...TOUR_STEPS, ...AREA_HINTS.map((hint) => hint.step)]) {
    assert.match(entry.id, /^[a-z0-9-]{1,40}$/, entry.id);
    const count = sentences(entry.text);
    assert.ok(count >= 1 && count <= 2, `${entry.id}: one or two sentences (${count})`);
    assert.ok(entry.text.length <= 160, `${entry.id}: short`);
    assert.ok(entry.title.length <= 30, `${entry.id}: short title`);
  }
  assert.equal(new Set(AREA_HINTS.map((hint) => hint.area)).size, AREA_HINTS.length, 'one hint per area');
});

test('the tour reaches every agreed data-tour name and every part the brief names', () => {
  const selectors = TOUR_STEPS.flatMap((entry) => entry.targets).join(' ');
  for (const name of TOUR_NAMES) assert.ok(selectors.includes(`[data-tour="${name}"]`), `a step for ${name}`);
  const ids = new Set(TOUR_STEPS.map((entry) => entry.id));
  for (const part of ['sidebar', 'chat-list', 'agent-create', 'tasks', 'composer', 'composer-send', 'composer-queue', 'run-stop', 'side-panel', 'my-day', 'call-button', 'settings', 'accounts', 'connectors', 'personality', 'feedback']) {
    assert.ok(ids.has(part), part);
  }
  // the steps whose target lives elsewhere say where the tour opens it
  for (const id of ['chat-list', 'composer', 'side-panel', 'tasks', 'agent-create', 'agent-view', 'accounts', 'connectors']) {
    assert.ok(TOUR_STEPS.find((entry) => entry.id === id)?.place, `${id} opens its place`);
  }
});
