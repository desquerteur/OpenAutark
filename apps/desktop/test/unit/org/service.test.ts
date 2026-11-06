import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { Org } from '../../../src/runtime/org/service.ts';
import { initials, paletteIndex } from '../../../src/runtime/org/avatar.ts';
import { parseTemplate } from '../../../src/runtime/org/templates.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { clock, memoryDb, recordingBus, RESOURCES } from '../store/helpers.ts';

function setup(templatesDir = path.join(RESOURCES, 'agents')) {
  const recorder = recordingBus();
  const time = clock();
  const org = new Org({ db: memoryDb(), bus: recorder.bus, clock: time, templatesDir });
  return { org, time, ...recorder };
}

const code = (expected: string) => (error: unknown) => error instanceof WorkforceError && error.code === expected;

test('seed: exactly one personal manager, no spaces, idempotent', () => {
  const { org } = setup();
  const manager = org.ensureSeed()!;
  assert.equal(manager.name, 'Manager');
  assert.equal(manager.role, 'Personal manager');
  assert.equal(manager.template, 'manager');
  assert.equal(manager.mode, 'manager');
  assert.equal(manager.managerId, undefined);
  assert.ok(manager.instructions.includes('personal manager – their right hand'));
  assert.equal(org.ensureSeed(), undefined);
  assert.equal(org.list().length, 1);
  assert.deepEqual(org.spaces(), []);
});

test('seed works without templates (falls back to manager mode)', () => {
  const { org } = setup(path.join(RESOURCES, 'does-not-exist'));
  const manager = org.ensureSeed()!;
  assert.equal(manager.mode, 'manager');
  assert.equal(manager.role, 'Personal manager');
});

test('all shipped templates parse with a known mode and instructions', () => {
  const { org } = setup();
  const templates = org.templates();
  const files = readdirSync(path.join(RESOURCES, 'agents')).filter((name) => name.endsWith('.md'));
  assert.equal(templates.length, files.length);
  assert.ok(templates.length >= 16);
  const modes = new Set(['general', 'manager', 'video', 'web', 'computer', 'browser', 'research', 'writing', 'social', 'secretary', 'harness', 'finance']);
  for (const template of templates) {
    assert.ok(modes.has(template.mode), `${template.key}: ${template.mode}`);
    assert.ok(template.instructions.length > 100, template.key);
    assert.ok(template.description, template.key);
  }
  const byKey = Object.fromEntries(templates.map((template) => [template.key, template]));
  assert.equal(byKey.secretary.spaceKind, 'private');
  assert.equal(byKey['video-editor'].mode, 'video');
  assert.equal(byKey['web-developer'].mode, 'web');
  assert.equal(byKey.researcher.mode, 'research');
  assert.equal(byKey.writer.mode, 'writing');
  assert.equal(byKey['computer-operator'].mode, 'computer');
});

test('template parser: inline and block lists, quotes, effort, invalid files', () => {
  const parsed = parseTemplate('x', '---\nname: "Ed"\nskills:\n  - a\n  - b\neffort: high\nspaceKind: nowhere\n---\nBody\n')!;
  assert.deepEqual(parsed.skills, ['a', 'b']);
  assert.equal(parsed.name, 'Ed');
  assert.equal(parsed.role, 'Ed');
  assert.equal(parsed.mode, 'general');
  assert.equal(parsed.effort, 'high');
  assert.equal(parsed.spaceKind, undefined);
  assert.equal(parsed.instructions, 'Body');
  assert.deepEqual(parseTemplate('y', '---\nname: Y\nskills: [one, "two"]\n---\n')!.skills, ['one', 'two']);
  assert.equal(parseTemplate('z', 'no front matter'), undefined);
  assert.equal(parseTemplate('Bad Key', '---\nname: A\n---\n'), undefined);
});

test('create from template: defaults, avatar, space by kind, unique names, events', () => {
  const { org, of } = setup();
  const manager = org.ensureSeed()!;
  const privateSpace = org.saveSpace({ name: 'Private', kind: 'private' });
  const secretary = org.create({ template: 'secretary', createdBy: 'human' });
  assert.equal(secretary.spaceId, privateSpace.id);
  assert.equal(secretary.mode, 'secretary');
  assert.equal(secretary.modelPolicy.effort, 'medium');
  assert.deepEqual(secretary.avatar, { kind: 'initials', value: secretary.name[0], color: paletteIndex(secretary.id) });
  assert.equal(secretary.role, 'Personal assistant', 'B-047: no name given – a human first name, the template role stays');
  const editor = org.create({ template: 'video-editor', createdBy: manager.id });
  assert.equal(editor.managerId, manager.id, 'agents hire into their own team');
  const brand = org.spaces().find((space) => space.kind === 'brand');
  assert.equal(editor.spaceId, brand?.id, 'the brand space is created with the first brand hire');
  assert.equal(brand?.name, 'Personal brand');
  const second = org.create({ template: 'video-editor', createdBy: 'human' });
  assert.notEqual(second.name, editor.name, 'B-047: each hire gets its own free first name');
  assert.match(second.name, /^\p{Lu}\p{Ll}+$/u);
  assert.notEqual(org.create({ name: editor.name.toUpperCase(), createdBy: 'human' }).name.toLowerCase(), editor.name.toLowerCase(), 'a taken name gets a number');
  assert.throws(() => org.create({ template: 'astronaut', createdBy: 'human' }), code('not_found'));
  assert.throws(() => org.create({ name: 'X', mode: 'Bad Mode', createdBy: 'human' }), code('bad_request'));
  assert.equal(second.spaceId, brand?.id, 'later brand hires reuse it');
  assert.equal(of('agent.upserted').length, 5, 'four hires and the one with a taken name');
  assert.equal(of('space.upserted').length, 2);
});

test('chain of command: managers(), canManage(), tree(), hiring limits', () => {
  const { org } = setup();
  const manager = org.ensureSeed()!;
  const lead = org.create({ template: 'marketing-lead', createdBy: manager.id });
  const creator = org.create({ template: 'content-creator', createdBy: lead.id });
  const other = org.create({ template: 'researcher', createdBy: 'human' });

  assert.deepEqual(org.managers(creator.id).map((agent) => agent.id), [lead.id, manager.id]);
  assert.equal(org.canManage('human', other.id), true);
  assert.equal(org.canManage(manager.id, creator.id), true);
  assert.equal(org.canManage(lead.id, creator.id), true);
  assert.equal(org.canManage(creator.id, lead.id), false);
  assert.equal(org.canManage(lead.id, lead.id), false);
  assert.equal(org.canManage(lead.id, other.id), false);
  assert.equal(org.canManage('human', 'ag_missing'), false);

  assert.equal(org.create({ name: 'Rogue', managerId: other.id, createdBy: lead.id }).managerId, other.id, 'any agent may hire into any team');
  const helper = org.create({ name: 'Helper', managerId: creator.id, createdBy: lead.id });
  assert.equal(helper.managerId, creator.id);

  const tree = org.tree();
  assert.deepEqual(tree.map((node) => node.agent.id), [manager.id, other.id]);
  assert.equal(tree[0].reports[0].agent.id, lead.id);
  assert.equal(tree[0].reports[0].reports[0].reports[0].agent.id, helper.id);
});

test('update: validation, no reporting cycles, initials follow renames, null clears', () => {
  const { org } = setup();
  const manager = org.ensureSeed()!;
  const report = org.create({ name: 'Ada Lovelace', managerId: manager.id, createdBy: 'human' });
  assert.equal(report.avatar.value, 'AL');
  const renamed = org.update(report.id, { name: 'Grace Hopper' });
  assert.equal(renamed.avatar.value, 'GH');
  assert.throws(() => org.update(manager.id, { managerId: report.id }), code('bad_request'));
  assert.throws(() => org.update(manager.id, { managerId: manager.id }), code('bad_request'));
  assert.throws(() => org.update(report.id, { name: 'manager' }), code('conflict'));
  assert.throws(() => org.update(report.id, { mode: '' }), code('bad_request'));
  assert.throws(() => org.update(report.id, { avatar: { kind: 'emoji', value: 'x', color: 9 } }), code('bad_request'));
  const moved = org.update(report.id, { managerId: null as never, team: 'Ops' });
  assert.equal(moved.managerId, undefined);
  assert.equal(moved.team, 'Ops');
  assert.equal(org.update(report.id, { name: 'Grace Hopper' }).name, 'Grace Hopper', 'same name is fine');
});

test('archive moves reports up and keeps at least one agent', () => {
  const { org, of } = setup();
  const manager = org.ensureSeed()!;
  assert.throws(() => org.archive(manager.id), code('conflict'));
  const lead = org.create({ template: 'marketing-lead', createdBy: manager.id });
  const creator = org.create({ template: 'content-creator', createdBy: lead.id });
  org.archive(lead.id);
  assert.equal(org.get(creator.id)?.managerId, manager.id);
  assert.equal(org.list().length, 2);
  assert.equal(org.list({ includeArchived: true }).length, 3);
  assert.deepEqual(of('agent.removed'), [{ id: lead.id }]);
  assert.throws(() => org.create({ name: 'Z', managerId: lead.id, createdBy: 'human' }), code('conflict'));
});

test('setStatus emits agent.upserted and agent.activity (default and injected source)', () => {
  const { org, of } = setup();
  const manager = org.ensureSeed()!;
  org.setStatus(manager.id, 'working', 'planning launch');
  const activity = of('agent.activity').at(-1) as { active: Array<{ agentId: string; note: string }> };
  assert.deepEqual(activity.active.map((entry) => [entry.agentId, entry.note]), [[manager.id, 'planning launch']]);
  assert.equal(org.get(manager.id)?.statusNote, 'planning launch');
  org.setActivitySource(() => [{ agentId: manager.id, runId: 'run_1', note: 'live', startedAt: 1 }]);
  org.setStatus(manager.id, 'idle');
  assert.equal((of('agent.activity').at(-1) as { active: Array<{ runId: string }> }).active[0].runId, 'run_1');
  assert.equal(org.get(manager.id)?.statusNote, undefined);
  assert.throws(() => org.setStatus('ag_missing', 'idle'), code('not_found'));
  assert.throws(() => org.setStatus(manager.id, 'dancing' as never), code('bad_request'));
});

test('spaces: create, update, archive', () => {
  const { org } = setup();
  const company = org.saveSpace({ name: 'Teydra', kind: 'company', color: '#112233' });
  const brand = org.saveSpace({ name: 'Brand', kind: 'brand' });
  assert.deepEqual(org.spaces().map((space) => space.sort), [0, 1]);
  const renamed = org.saveSpace({ id: company.id, name: 'Teydra Lab' });
  assert.equal(renamed.kind, 'company');
  assert.equal(renamed.color, '#112233');
  assert.throws(() => org.saveSpace({ name: 'X', kind: 'galaxy' as never }), code('bad_request'));
  assert.throws(() => org.saveSpace({ id: 'sp_missing', name: 'X' }), code('not_found'));
  org.archiveSpace(brand.id);
  assert.deepEqual(org.spaces().map((space) => space.id), [company.id]);
});

test('avatar helpers', () => {
  assert.equal(initials('content creator'), 'CC');
  assert.equal(initials('Manager'), 'M');
  assert.equal(initials('  '), '?');
  assert.equal(initials('élan vital extra'), 'ÉV');
  assert.equal(paletteIndex('ag_x'), paletteIndex('ag_x'));
  assert.ok(paletteIndex('ag_y') >= 0 && paletteIndex('ag_y') < 6);
});
