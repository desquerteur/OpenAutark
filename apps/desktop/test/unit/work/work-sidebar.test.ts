// Work's sidebar and routes (B-078 D10, src/ui/tasks/work-model.ts, shell/TaskFiltersNav.tsx): "People & agents" with
// "Unassigned" (no more All work · Stuck · Done views), the owner chip's words, the plain Work route (older
// #/tasks/<filter> links open the plain view) and that no sidebar click keeps a selected task.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ownerChipLabel, withTask, workOwners, workRoute } from '../../../src/ui/tasks/work-model.ts';
import { ANNA, MARA, NOW, TOM, task, todo, unowned } from './fixture.ts';

test('workOwners: every agent and person with open work, most first, then by name; unassigned counted apart', () => {
  const names: Record<string, string> = { [MARA]: 'Mara', [TOM]: 'Tom', [ANNA]: 'Anna Berg', ag_zoe: 'Zoe' };
  const nameOf = (id: string) => names[id] ?? 'Former member';
  const open = [
    task({ assigneeId: TOM }), task({ assigneeId: TOM }), task({ assigneeId: MARA }), task({ assigneeKind: 'human', assigneeId: ANNA }),
    task({ assigneeId: 'ag_zoe', status: 'done' }), task({ assigneeId: 'ag_zoe', parentId: 'task_x' }), // finished work and steps: no row
    unowned(), unowned({ status: 'waiting', waitingOn: { kind: 'task', reason: 'After', since: NOW } }), todo(), todo({ status: 'needs_you' }),
  ];
  const { owners, unassigned } = workOwners(open, nameOf);
  assert.deepEqual(owners.map((owner) => [owner.id, owner.kind, owner.count]), [[TOM, 'agent', 2], [ANNA, 'person', 1], [MARA, 'agent', 1]]);
  assert.equal(unassigned, 2);
  assert.deepEqual(workOwners([todo()], nameOf), { owners: [], unassigned: 0 }, 'the person is never an owner row');
  assert.equal(ownerChipLabel('team', nameOf), 'Unassigned', 'the chip says what the sidebar says');
  assert.equal(ownerChipLabel(ANNA, nameOf), 'Anna Berg');
});

test('the Work route: plain or narrowed to an owner, never with a view filter; a task selected or not', () => {
  assert.deepEqual(workRoute(), { view: 'tasks' });
  assert.deepEqual(workRoute(MARA), { view: 'tasks', owner: MARA });
  assert.deepEqual(withTask(workRoute(MARA), 'task_1'), { view: 'tasks', owner: MARA, task: 'task_1' });
  assert.deepEqual(withTask({ view: 'tasks', filter: 'done', task: 'task_1' }), { view: 'tasks', filter: 'done' });
});

test('the sidebar has no view rows and no ?task=; Work shows the cards and the report, the composer and its posts', () => {
  const root = path.resolve(import.meta.dirname, '../../../src/ui');
  const nav = readFileSync(path.join(root, 'shell/TaskFiltersNav.tsx'), 'utf8');
  assert.doesNotMatch(nav, /WORK_VIEWS|workCounts|workViewOf/, 'the All work · Stuck · Done rows are gone');
  assert.match(nav, /navigate\(workRoute\(owner === id \? undefined : id\)\)/, 'a second click on an owner clears it');
  assert.doesNotMatch(nav, /withTask\(|\btask: /, 'no ?task= from the sidebar');
  const view = readFileSync(path.join(root, 'tasks/TasksView.tsx'), 'utf8');
  assert.doesNotMatch(view, /MobileViews|Show older|task-group/, 'no groups, phone view chips or Show older');
  assert.match(view, /<ForYouCards /);
  assert.match(view, /<WorkReport /);
  assert.match(view, /<TaskComposer \/>/, 'the quick composer');
  assert.match(view, /<PendingPosts \/>/, 'the composer\'s posts right below it');
  const pane = readFileSync(path.join(root, 'tasks/WorkIndex.tsx'), 'utf8');
  assert.doesNotMatch(pane, /FilterMenu/, 'the pane has no filter menu of its own');
});
