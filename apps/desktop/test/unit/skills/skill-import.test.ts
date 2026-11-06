// Skills from an agent file arrive as the owner's own, usable at once, under a free name (a taken name gets -2);
// descriptions with quotes and backslashes round-trip through SKILL.md; every skill loads for every agent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { SkillLibrary } from '../../../src/runtime/skills/service.ts';
import { parseFrontMatter } from '../../../src/runtime/skills/frontmatter.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';

function agent(id: string, skills: string[] = []): Agent {
  return { id, name: id, role: '', avatar: { kind: 'initials', value: 'A' }, instructions: '', mode: 'writing', skills,
    modelPolicy: {}, status: 'idle', createdBy: 'human', createdAt: 0, updatedAt: 0 } as Agent;
}

const writing = { key: 'writing', skills: [] } as unknown as ModeInfo;

test('importSkill: the new agent\'s own skill under a free name, indexed for it, loadable by everyone', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wf-skill-import-'));
  try {
    const workspace = path.join(root, 'workspace');
    mkdirSync(path.join(workspace, 'skills', 'blog-style'), { recursive: true });
    writeFileSync(path.join(workspace, 'skills', 'blog-style', 'SKILL.md'), '---\nname: blog-style\ndescription: Our blog voice\n---\n\nSteps.\n');
    const skills = new SkillLibrary({ paths: { workspace, resources: path.join(root, 'resources') }, clock: new ManualClock(), home: '' });
    const imported = skills.importSkill({ name: 'blog-style', description: 'Write like "us"\n with C:\\paths', body: 'Use short lines.', modes: ['writing'], ownerAgentId: 'ag_new' });
    assert.equal(imported.name, 'blog-style-2', 'the workspace skill keeps its name');
    assert.equal(imported.ownerAgentId, 'ag_new');
    assert.equal(imported.description, 'Write like "us" with C:\\paths', 'quotes and backslashes round-trip');
    assert.deepEqual(parseFrontMatter(readFileSync(path.join(imported.path, 'SKILL.md'), 'utf8')).data.metadata, { modes: ['writing'] });
    assert.ok(skills.indexFor(agent('ag_new'), writing).some((info) => info.name === 'blog-style-2'), 'in its owner\'s index');
    assert.ok(!skills.indexFor(agent('ag_other'), writing).some((info) => info.name === 'blog-style-2'), 'not in another agent\'s index');
    assert.equal(skills.get('blog-style-2')?.body, 'Use short lines.', 'but anyone may load it by name');
    assert.throws(() => skills.importSkill({ name: 'Bad Name', description: 'x', body: '', modes: [], ownerAgentId: 'ag_new' }), /valid name/);
    assert.throws(() => skills.importSkill({ name: 'ok-name', description: 'x', body: '', modes: [], ownerAgentId: '../escape' }), /Invalid agent folder/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
