// AF-018 context: the chat header's project chip (which project a chat is in, what the chip says), the command
// palette's project entries (owner only, open / new session / Add project…) and the window's list update.
// Owns: these assertions only. Never: a runtime, git or a real window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Member } from '../../../src/shared/model/chat.ts';
import type { Project } from '../../../src/shared/model/project.ts';
import { changedText, chatProject, chipText } from '../../../src/ui/chat/project-chip.ts';
import { projectEntries, shortFolder } from '../../../src/ui/shell/palette-projects.ts';
import { folderName, projectHash, withProject } from '../../../src/ui/lib/projects.ts';

function project(id: string, over: Partial<Project> = {}): Project {
  return {
    id, folder: `C:\\code\\${id}`, name: id, source: 'added', pinned: false, addedAt: 1, lastActiveAt: 1,
    agents: [], sessions: [], about: '', ...over,
  };
}
const git = (over: Partial<NonNullable<Project['git']>> = {}): NonNullable<Project['git']> => ({ branch: 'main', head: 'abc1234', dirty: 0, ahead: 0, behind: 0, branches: ['main'], ...over });
const member = (memberId: string, over: Partial<Member> = {}): Member => ({ conversationId: 'c1', memberId, kind: memberId === 'human' ? 'human' : 'agent', role: 'member', readSeq: 0, joinedAt: 1, ...over });
const chat = (members: Member[], working: string[] = []) => ({ id: 'c1', members, working });

test('chatProject: a project listing the chat as its session wins over agent folders', () => {
  const byAgent = project('a', { agents: [{ id: 'ag1', name: 'Ava' }] });
  const bySession = project('b', { sessions: [{ conversationId: 'c1', title: 'Fix', agentIds: [], lastAt: 1, working: false }] });
  assert.equal(chatProject(chat([member('human'), member('ag1')]), [byAgent, bySession])?.id, 'b');
});

test('chatProject: by the chat\'s current agents; the answering one first, else the list order', () => {
  const one = project('one', { agents: [{ id: 'ag1', name: 'Ava' }] });
  const two = project('two', { agents: [{ id: 'ag2', name: 'Mira' }] });
  const both = chat([member('human'), member('ag1'), member('ag2')]);
  assert.equal(chatProject(both, [one, two])?.id, 'one');
  assert.equal(chatProject({ ...both, working: ['ag2'] }, [one, two])?.id, 'two');
  assert.equal(chatProject(chat([member('human'), member('ag1', { leftAt: 5 })]), [one, two]), undefined, 'an agent that left does not count');
  assert.equal(chatProject(chat([member('human')]), [one, two]), undefined);
  assert.equal(chatProject(both, []), undefined);
});

test('chipText: name · branch · N changed, clean and non-git trees stay short', () => {
  assert.deepEqual(chipText(project('autark', { git: git({ dirty: 3 }) })).parts, ['autark', 'main', '3 changed']);
  assert.deepEqual(chipText(project('autark', { git: git() })).parts, ['autark', 'main']);
  assert.deepEqual(chipText(project('notes')).parts, ['notes']);
  assert.deepEqual(chipText(project('x', { git: git({ branch: null }) })).parts, ['x', 'abc1234'], 'detached: the short sha');
  const title = chipText(project('autark', { git: git({ dirty: 1 }) })).title;
  assert.match(title, /C:\\code\\autark/);
  assert.match(title, /On main · 1 changed/);
  assert.match(chipText(project('notes')).title, /Not a git repository/);
  assert.match(chipText(project('gone', { missing: true, git: git() })).title, /no longer exists/);
  assert.equal(changedText(0), '');
});

test('projectEntries: owner only; open and new session per project, Add project… where a folder can be chosen', () => {
  const list = [project('autark'), project('gone', { missing: true })];
  assert.deepEqual(projectEntries(list, { owner: false, canPick: true }), []);
  const entries = projectEntries(list, { owner: true, canPick: true });
  assert.deepEqual(entries.map((entry) => entry.label), ['Open project: autark', 'New session in autark', 'Open project: gone', 'Add project…']);
  assert.equal(entries[0]?.hint, 'code\\autark');
  assert.equal(entries[2]?.hint, 'Folder missing');
  assert.equal(entries[1]?.projectId, 'autark');
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length, 'unique ids');
  assert.ok(!projectEntries(list, { owner: true, canPick: false }).some((entry) => entry.kind === 'add'), 'no folder dialog (phone, browser): no Add');
});

test('folders and hashes: short names, the project page hash, the list update', () => {
  assert.equal(shortFolder('C:\\Users\\me\\code\\autark'), 'code\\autark');
  assert.equal(shortFolder('/home/me/autark/'), 'me/autark');
  assert.equal(folderName('C:\\code\\autark\\'), 'autark');
  assert.equal(folderName('/srv/shop'), 'shop');
  assert.equal(projectHash('p 1/x'), '#/projects/p%201%2Fx');
  const a = project('a');
  const b = project('b');
  assert.deepEqual(withProject([a, b], { ...a, name: 'Renamed' }).map((entry) => entry.name), ['Renamed', 'b']);
  assert.deepEqual(withProject([a], b).map((entry) => entry.id), ['a', 'b']);
});
