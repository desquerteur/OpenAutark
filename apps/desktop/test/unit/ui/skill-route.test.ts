// Settings › Skills & memory: the words for a skill's route, and that the page's list holds an agent's own copy beside the shared
// one it stands in for (the name-by-name list leaves it out).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SkillInfo } from '../../../src/shared/model/knowledge.ts';
import { SkillLibrary } from '../../../src/runtime/skills/service.ts';
import { skillRoute, skillRows } from '../../../src/ui/settings/skill-route.ts';

const skill = (over: Partial<SkillInfo>): SkillInfo => ({ name: 'x', description: '', source: 'builtin', path: '/x', modes: [], updatedAt: 0, ...over });
const nameOf = (id: string) => (id === 'ag_b' ? 'Ben' : 'Ada');
const isManager = (id: string) => id === 'ag_b';

test('a route names who a skill reaches, and `always` follows it', () => {
  assert.equal(skillRoute(skill({ source: 'builtin' }), nameOf, isManager), 'Built-in');
  assert.equal(skillRoute(skill({ source: 'user' }), nameOf, isManager), 'Shared');
  assert.equal(skillRoute(skill({ source: 'agent', ownerAgentId: 'ag_a' }), nameOf, isManager), 'Own · Ada');
  assert.equal(skillRoute(skill({ source: 'agent', ownerAgentId: 'ag_b' }), nameOf, isManager), 'Manager · Ben');
  assert.equal(skillRoute(skill({ source: 'user', always: true }), nameOf, isManager), 'Shared · always');
  assert.deepEqual(skillRows([skill({ name: 'a', source: 'builtin' }), skill({ name: 'c', source: 'agent' }), skill({ name: 'b', source: 'user' })]).map((row) => row.name), ['b', 'c', 'a']);
});

test('every() lists each copy, list() one per name', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-skill-every-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (folder: string) => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: memo\ndescription: Writes memos.\n---\nBody\n');
  };
  write(path.join(dir, 'workspace', 'skills', 'memo'));
  write(path.join(dir, 'workspace', 'agents', 'ag_a', 'skills', 'memo'));
  const library = new SkillLibrary({ paths: { workspace: path.join(dir, 'workspace'), resources: path.join(dir, 'resources') }, clock: { now: () => 0 } as never, home: '' });
  assert.equal(library.list().length, 1);
  assert.deepEqual(library.every().map((info) => info.source).sort(), ['agent', 'user']);
});
