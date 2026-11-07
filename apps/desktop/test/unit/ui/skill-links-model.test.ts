// AF-007: the words of "Add from link" and of an update – where a source lives, a skill's files, the scripts warning,
// the change lines and summary, the place select's keys and the first choice.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeText, filesLine, firstChoice, scriptWarning, sourceText, targetKey, targetOf, updateSummary } from '../../../src/ui/settings/skill-links-model.ts';
import type { SkillLinkCandidate, SkillLinkTarget } from '../../../src/shared/model/skill-links.ts';

const skill = (route: string): SkillLinkCandidate => ({ route, name: route || 'root', description: 'd', files: [{ path: 'SKILL.md', size: 2048 }, { path: 'run.sh', size: 10, script: true }], size: 2058, scripts: ['run.sh'], notes: [] });

test('a source reads as where it lives', () => {
  assert.equal(sourceText({ kind: 'github', url: 'https://github.com/anthropics/skills/tree/main/skills/pdf', repo: 'anthropics/skills', ref: 'main', folder: 'skills/pdf' }), 'github.com/anthropics/skills/skills/pdf · main');
  assert.equal(sourceText({ kind: 'github', url: 'https://github.com/o/r', repo: 'o/r' }), 'github.com/o/r');
  assert.equal(sourceText({ kind: 'file', url: 'https://example.com/a/b/c/d/SKILL.md' }), 'example.com/a/…/d/SKILL.md');
  assert.equal(sourceText({ kind: 'zip', url: 'https://example.com/x.zip' }), 'example.com/x.zip');
  assert.equal(sourceText({ kind: 'upload', url: 'notes.zip' }), 'Uploaded notes.zip');
});

test('files, scripts and changes in one line each', () => {
  assert.equal(filesLine(skill('a')), '2 files · 2 KB');
  assert.equal(scriptWarning([]), '');
  assert.match(scriptWarning(['run.sh']), /^Contains a script: run\.sh\. It is only saved – nothing runs when installing\./);
  assert.match(scriptWarning(['a', 'b', 'c', 'd', 'e']), /a, b, c and 2 more/);
  assert.equal(changeText({ path: 'forms.md', change: 'changed', size: 9, lines: { added: 2, removed: 1 }, local: true }), 'Changed · forms.md · +2 −1 lines · your edit is replaced');
  assert.equal(changeText({ path: 'run.sh', change: 'added', size: 2048, script: true }), 'Added · run.sh · 2 KB · script');
  assert.equal(changeText({ path: 'old.md', change: 'removed', size: 3, local: true }), 'Removed · old.md · 3 B · your edit is removed');
  assert.equal(updateSummary([], 4), 'Up to date – nothing changes.');
  assert.equal(updateSummary([{ path: 'a', change: 'changed', size: 1 }, { path: 'b', change: 'added', size: 1 }, { path: 'c', change: 'removed', size: 1 }], 3), '1 file changes, 1 new, 1 removed · 3 unchanged');
});

test('the place select and the first choice', () => {
  const targets: SkillLinkTarget[] = [
    { target: { kind: 'shared' }, label: 'Shared', hint: '', folder: '/w/skills' },
    { target: { kind: 'agent', agentId: 'ada' }, label: 'Ada', hint: '', folder: '/w/agents/ada/skills' },
    { target: { kind: 'project', agentId: 'ada' }, label: 'Ada\'s project', hint: '', folder: '/p/.claude/skills' },
  ];
  assert.deepEqual(targets.map((entry) => targetKey(entry.target)), ['shared', 'agent:ada', 'project:ada']);
  assert.deepEqual(targetOf('project:ada', targets), { kind: 'project', agentId: 'ada' });
  assert.equal(targetOf('agent:nobody', targets), undefined);
  assert.deepEqual(firstChoice([skill('')]), ['']);
  assert.deepEqual(firstChoice([skill('a'), skill('b')]), []);
});
