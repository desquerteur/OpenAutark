// The B-041 routes of the hash router (src/ui/lib/router.ts): My day (#/day, #/day/<YYYY-MM-DD>,
// an older #/tasks/for-you), the task open in Work's detail (?task=, next to ?owner=), a person's
// page and a split – parsed and formatted both ways, unknown or broken parts falling back to the plain
// view.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRoute, parseRoute, SETTINGS_PAGES, settingsPage } from '../../../src/ui/lib/router.ts';
import type { Route } from '../../../src/ui/lib/router.ts';

test('#/day: today, a real date, and anything else opens today', () => {
  assert.deepEqual(parseRoute('#/day'), { view: 'day' });
  assert.deepEqual(parseRoute('#/day/2026-10-24'), { view: 'day', date: '2026-10-24' });
  assert.deepEqual(parseRoute('#/day/2026-02-30'), { view: 'day' }, 'a day that does not exist');
  assert.deepEqual(parseRoute('#/day/tomorrow'), { view: 'day' });
  assert.equal(formatRoute({ view: 'day' }), '#/day');
  assert.equal(formatRoute({ view: 'day', date: '2026-10-24' }), '#/day/2026-10-24');
});

test('#/tasks/for-you (For you, before B-041) opens My day', () => {
  assert.deepEqual(parseRoute('#/tasks/for-you'), { view: 'day' });
  assert.deepEqual(parseRoute('#/tasks/for-you?owner=ag_mara'), { view: 'day' });
});

test('#/tasks?task=: the open task, alone and next to the owner and a filter', () => {
  assert.deepEqual(parseRoute('#/tasks?task=ta_1'), { view: 'tasks', task: 'ta_1' });
  assert.deepEqual(parseRoute('#/tasks/done?owner=ag_mara&task=ta_1'), { view: 'tasks', filter: 'done', owner: 'ag_mara', task: 'ta_1' });
  assert.deepEqual(parseRoute('#/tasks?task='), { view: 'tasks' });
  assert.equal(formatRoute({ view: 'tasks', task: 'ta_1' }), '#/tasks?task=ta_1');
  assert.equal(formatRoute({ view: 'tasks', filter: 'stuck', owner: 'team', task: 'ta 2' }), '#/tasks/stuck?owner=team&task=ta%202');
});

test('#/team/person/<id>; an agent page stays as it was', () => {
  assert.deepEqual(parseRoute('#/team/person/per_anna'), { view: 'team', personId: 'per_anna' });
  assert.deepEqual(parseRoute('#/team/person'), { view: 'team' }, 'no id: the team');
  assert.deepEqual(parseRoute('#/team/ag_mara'), { view: 'team', agentId: 'ag_mara' });
  assert.equal(formatRoute({ view: 'team', personId: 'per_anna' }), '#/team/person/per_anna');
  assert.equal(formatRoute({ view: 'team', agentId: 'ag_mara' }), '#/team/ag_mara');
  assert.equal(formatRoute({ view: 'team' }), '#/team');
});

test('#/settings/agents opens Team; a settings page stays the section', () => {
  assert.deepEqual(parseRoute('#/settings/agents'), { view: 'team' });
  assert.deepEqual(parseRoute('#/settings/models'), { view: 'settings', section: 'models' });
  assert.deepEqual(parseRoute('#/settings'), { view: 'settings' });
});

test('every page opens itself, an older name the page that holds its rows, an unknown one the first page', () => {
  for (const page of SETTINGS_PAGES) assert.deepEqual(parseRoute('#/settings/' + page), { view: 'settings', section: page });
  assert.deepEqual(parseRoute('#/settings/remote'), { view: 'settings', section: 'devices' });
  assert.deepEqual(parseRoute('#/settings/abilities'), { view: 'settings', section: 'models' });
  assert.deepEqual(parseRoute('#/settings/advanced'), { view: 'settings', section: 'about' });
  assert.deepEqual(parseRoute('#/settings/usage'), { view: 'settings', section: 'models' });
  assert.deepEqual(parseRoute('#/settings/profile'), { view: 'settings', section: 'general' });
  assert.deepEqual(parseRoute('#/settings/memory'), { view: 'settings', section: 'skills' });
  assert.deepEqual(parseRoute('#/settings/nothing-like-it'), { view: 'settings' });
  assert.equal(settingsPage('Models'), 'models', 'the name is not case sensitive');
  // B-078: the Voice page joined Models – older links open Models
  assert.equal(settingsPage('Voice'), 'models');
  assert.deepEqual(parseRoute('#/settings/speech'), { view: 'settings', section: 'models' });
  assert.ok(!(SETTINGS_PAGES as readonly string[]).includes('voice'));
  assert.equal(settingsPage(undefined), undefined);
});

test('every new route survives a round trip', () => {
  const routes: Route[] = [
    { view: 'home' }, { view: 'day' }, { view: 'day', date: '2027-01-01' },
    { view: 'tasks', task: 'ta_1' }, { view: 'tasks', filter: 'done', owner: 'a b&c', task: 't/1' },
    { view: 'team', personId: 'per_x y' }, { view: 'team', agentId: 'ag_1' }, { view: 'team', agentId: 'ag_1', splitId: 'sp_1' },
  ];
  for (const route of routes) assert.deepEqual(parseRoute(formatRoute(route)), route, formatRoute(route));
});
