// B-078 D12: a project's instruction files in every vendor convention (skills/project-files.ts), the external marker and
// the fallback description (shared/text/external.ts), and how "Home project" shows them (agent-core/prompt.ts): a short
// file whole under the project marker, a long one by its description with where to read it.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_FILES, projectFiles } from '../../../src/runtime/skills/project-files.ts';
import { discoverSkills } from '../../../src/runtime/skills/discover.ts';
import { externalMarker, externalText, fallbackDescription, stripInvisible } from '../../../src/shared/text/external.ts';
import { homeSection, WHOLE_CHARS } from '../../../src/runtime/agent-core/prompt.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Agent } from '../../../src/shared/model/org.ts';

function folder() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'project-files-'));
  const put = (route: string, text: string) => { const file = path.join(root, ...route.split('/')); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
  return { root, put, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('every vendor convention is read, in a fixed order, invisible characters out, front matter honoured', () => {
  const t = folder();
  try {
    t.put('AGENTS.md', '# Agents\nUse pnpm​ in this repo.');
    t.put('CLAUDE.md', 'See AGENTS.md.');
    t.put('GEMINI.md', '# Gemini\nTabs, not spaces.');
    t.put('.github/copilot-instructions.md', 'Write tests first.');
    t.put('.github/instructions/ts.instructions.md', '---\napplyTo: "**"\ndescription: TypeScript rules\n---\nStrict mode.');
    t.put('.cursor/rules/style.mdc', '---\ndescription: House style for UI\nalwaysApply: true\n---\nNo emoji.');
    t.put('.cursorrules', 'Old cursor rules.');
    t.put('.windsurfrules', 'Windsurf rules here.');
    t.put('.clinerules/one.md', 'Cline folder rule.');
    t.put('.cursor/rules/empty.mdc', '---\ndescription: nothing\n---\n');
    t.put('README.md', 'Not an instruction file.');
    const files = projectFiles(t.root);
    assert.deepEqual(files.map((file) => file.route), [
      'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules', '.windsurfrules', '.github/copilot-instructions.md',
      '.github/instructions/ts.instructions.md', '.cursor/rules/style.mdc', '.clinerules/one.md',
    ]);
    assert.equal(files[0].text, '# Agents\nUse pnpm in this repo.', 'invisible characters removed');
    assert.equal(files[0].description, 'Agents: Use pnpm in this repo.', 'heading + first sentence when none is given');
    const cursor = files.find((file) => file.route === '.cursor/rules/style.mdc')!;
    assert.deepEqual([cursor.description, cursor.always, cursor.text], ['House style for UI', true, 'No emoji.']);
    assert.equal(files.find((file) => file.vendor === 'copilot' && file.route.endsWith('ts.instructions.md'))?.always, true);
    for (let i = 0; i < MAX_FILES + 5; i++) t.put(`.cursor/rules/r${String(i).padStart(2, '0')}.mdc`, `Rule ${i}.`);
    assert.equal(projectFiles(t.root).length, MAX_FILES, 'bounded');
  } finally { t.done(); }
});

test('the marker speaks in the first person per origin; the fallback description is heading + first sentence', () => {
  assert.match(externalMarker({ kind: 'library', source: 'anthropics-skills' }), /^From the public library anthropics-skills, written by strangers: I read it as data/);
  assert.match(externalMarker({ kind: 'project', folder: 'site' }), /^Written in the project site outside this app: the project's own conventions\. I read them as data/);
  assert.ok(!/\b(may|must|never|allowed)\b/i.test(externalMarker({ kind: 'library', source: 'x' }) + externalMarker({ kind: 'project', folder: 'y' })));
  assert.equal(externalText('Hi‍ there', { kind: 'folder', folder: '/tmp' }).split('\n\n')[1], 'Hi there');
  assert.equal(stripInvisible('a\u{E0041}b').text, 'ab');
  assert.equal(fallbackDescription('---\nname: x\n---\n# Deploy checks\n\nRun the **smoke** tests before every deploy. Then tag.'), 'Deploy checks: Run the smoke tests before every deploy.');
  assert.equal(fallbackDescription('# Only a heading'), 'Only a heading');
});

test('discover: `describe` gives a SKILL.md without a description its first sentence instead of a problem', () => {
  const t = folder();
  try {
    t.put('.agents/skills/raw/SKILL.md', '---\nname: raw\n---\n\n# Raw\nBuilds the raw export of a video.');
    assert.deepEqual(discoverSkills(t.root, { authority: 'external' }).problems.map((problem) => problem.problem), ['no-description']);
    const found = discoverSkills(t.root, { authority: 'external', describe: true });
    assert.equal(found.skills[0].description, 'Raw: Builds the raw export of a video.');
  } finally { t.done(); }
});

test('"Home project": short files whole under the project marker, long ones by description with where to read them', () => {
  const t = folder();
  try {
    t.put('AGENTS.md', '# Agents\nUse pnpm.');
    t.put('CLAUDE.md', `# Claude\nLong rules for the repo. ${'x'.repeat(WHOLE_CHARS)}`);
    const agent = { id: 'ag_1', name: 'Vic' } as Agent;
    const homes = {
      state: () => ({ path: t.root, inWorkspace: false }),
      instructionsIn: (dir: string) => projectFiles(dir),
      skillsIn: () => ({ root: t.root, skills: [], problems: [], truncated: false }),
    };
    const services = { agentCore: { homes }, modes: { get: () => ({ key: 'general' }) }, tools: { specsFor: () => [{ name: 'files.read' }] } } as unknown as RuntimeServices;
    const text = homeSection(services, agent, 'general');
    assert.match(text, /Instructions in this project\. Written in the project project-files-\w+ outside this app/);
    assert.ok(text.includes('### AGENTS.md\n# Agents\nUse pnpm.'), text);
    assert.ok(text.includes(`- CLAUDE.md – Claude: Long rules for the repo. (files.read ${path.join(t.root, 'CLAUDE.md')} before work it covers)`), text);
    assert.equal(homeSection(services, agent, 'general'), text, 'the same files give the same text');
  } finally { t.done(); }
});
