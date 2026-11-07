// AF-014: an agent from a folder – the suggestions (name and role from package.json, pyproject.toml, the README or the
// folder's name), what the folder brings (instruction files, skills, other tools' settings), the agent's starting text,
// the Explorer entry's command lines and flag, and the Team list grouped by folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeFolder, displayName, readmeParts } from '../../../src/runtime/folder-agents/analyze.ts';
import { folderAgentText } from '../../../src/runtime/folder-agents/create.ts';
import { FOLDER_FLAG, MENU_KEYS, ensureExplorerMenu, folderFromArgv, menuCommand, registerCalls, removeCalls, setExplorerMenu } from '../../../src/main/explorer-menu.ts';
import { fileUrlPath, folderGroups } from '../../../src/ui/team/folder-agent.ts';
import type { Agent } from '../../../src/shared/model/org.ts';

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'af014-'));
  for (const [route, text] of Object.entries(files)) {
    const file = path.join(dir, ...route.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

test('a Node repo: name and role from package.json, its instruction files, skills and other settings', (t) => {
  const dir = repo({
    'package.json': JSON.stringify({ name: '@acme/shop-front', description: 'Web shop front end', devDependencies: { typescript: '5', react: '19' } }),
    'README.md': '# Acme Shop\n\n[![build](x.svg)](y)\n\nThe shop people buy from.\n',
    'CLAUDE.md': '# Rules\nAlways run npm test before a commit.\n',
    'AGENTS.md': 'Use pnpm, never npm install.\n',
    '.claude/skills/release/SKILL.md': '---\nname: release\ndescription: How we ship a release\n---\nSteps.\n',
    '.codex/skills/db-migrate/SKILL.md': '---\nname: db-migrate\ndescription: Migrate the database\n---\nSteps.\n',
    '.codex/config.toml': 'model = "x"\n',
    '.codex/prompts/review.md': 'Review this.\n',
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const found = analyzeFolder(dir, [{ id: 'ag_1', name: 'Ada' }]);
  assert.equal(found.name, 'Shop Front');
  assert.equal(found.role, 'Works on Shop Front: Web shop front end');
  assert.equal(found.source, 'package.json');
  assert.equal(found.about, 'Web shop front end');
  assert.deepEqual(found.instructions, ['AGENTS.md', 'CLAUDE.md']);
  assert.deepEqual(found.skills, ['db-migrate', 'release']);
  assert.deepEqual(found.configs, ['.codex/config.toml', '.codex/prompts/review.md']);
  assert.deepEqual(found.agents, [{ id: 'ag_1', name: 'Ada' }]);
  assert.equal(found.label, path.basename(dir));

  const text = folderAgentText(found);
  assert.match(text, new RegExp(`I work on the project in ${dir.replace(/\\/g, '\\\\')}`));
  assert.match(text, /I follow the project's own instructions for all work in this folder: AGENTS\.md, CLAUDE\.md/);
  assert.match(text, /skills are mine to use: db-migrate, release/);
  assert.match(text, /\.codex\/config\.toml/);
});

test('other manifests, the README and the folder name as fallbacks', (t) => {
  const py = repo({ 'pyproject.toml': '[project]\nname = "data_tools"\ndescription = "Small helpers for CSV files"\n' });
  const readme = repo({ 'README.md': 'Weather Bot\n===========\n\n```sh\nrun\n```\n\nA bot that posts the **weather** every morning. It runs on a Pi.\n' });
  const bare = repo({});
  t.after(() => { for (const dir of [py, readme, bare]) rmSync(dir, { recursive: true, force: true }); });
  const a = analyzeFolder(py);
  assert.deepEqual([a.name, a.source, a.role], ['Data Tools', 'pyproject.toml', 'Works on Data Tools: Small helpers for CSV files']);
  const b = analyzeFolder(readme);
  assert.deepEqual([b.name, b.source], ['Weather Bot', 'README']);
  assert.equal(b.about, 'A bot that posts the weather every morning. It runs on a Pi.');
  assert.equal(b.role, 'Works on Weather Bot: A bot that posts the weather every morning');
  const c = analyzeFolder(bare);
  assert.equal(c.source, 'folder name');
  assert.deepEqual([c.instructions, c.skills, c.configs], [[], [], []]);
  assert.doesNotMatch(folderAgentText(c), /follow|skills/, 'nothing promised that is not there');
  assert.equal(displayName('my-cool_app'), 'My Cool App');
  assert.equal(displayName('@scope/iOS-kit'), 'iOS Kit', 'a word with inner capitals keeps them');
  assert.deepEqual(readmeParts('# Title\n\n<p>html</p>\n\nReal text here.'), { title: 'Title', about: 'Real text here.' });
});

test('the Explorer entry: per-user keys, the command line, the flag, removing it and the start-up check', async (t) => {
  assert.ok(MENU_KEYS.every((key) => key.startsWith('HKCU\\Software\\Classes\\Directory\\')), 'this user only');
  const exe = 'C:\\Program Files\\Autark\\Autark.exe';
  assert.equal(menuCommand(exe, [], '%1'), `"${exe}" ${FOLDER_FLAG} "%1"`);
  assert.equal(menuCommand('C:\\e\\electron.exe', ['C:\\src\\app'], '%V'), `"C:\\e\\electron.exe" "C:\\src\\app" ${FOLDER_FLAG} "%V"`);
  const calls = registerCalls(exe, []);
  assert.equal(calls.length, 6);
  assert.deepEqual(calls[2], ['add', `${MENU_KEYS[0]}\\command`, '/ve', '/d', `"${exe}" ${FOLDER_FLAG} "%1"`, '/f']);
  assert.deepEqual(calls[5]!.at(-2), `"${exe}" ${FOLDER_FLAG} "%V"`, 'the background entry passes the open folder');
  assert.deepEqual(removeCalls(), MENU_KEYS.map((key) => ['delete', key, '/f']));
  assert.equal(folderFromArgv(['Autark.exe', FOLDER_FLAG, 'C:\\code\\shop']), 'C:\\code\\shop');
  assert.equal(folderFromArgv(['Autark.exe', `${FOLDER_FLAG}=C:\\code\\shop`]), 'C:\\code\\shop');
  assert.equal(folderFromArgv(['Autark.exe', '--background']), undefined);

  const dir = mkdtempSync(path.join(os.tmpdir(), 'af014-menu-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ran: string[][] = [];
  const deps = { platform: 'win32' as const, exe, prefix: [], dir, run: async (_command: string, args: string[]) => { ran.push(args); return { code: 0, stdout: '', stderr: '' }; } };
  await ensureExplorerMenu({ ...deps, packaged: false });
  assert.equal(ran.length, 0, 'a development run registers nothing by itself');
  await ensureExplorerMenu({ ...deps, packaged: true });
  assert.equal(ran.length, 6, 'the first packaged start registers it');
  await ensureExplorerMenu({ ...deps, packaged: true });
  assert.equal(ran.length, 6, 'current already: nothing to do');
  assert.equal(await setExplorerMenu(false, deps), false);
  assert.deepEqual(ran.slice(6).map((args) => args[0]), ['delete', 'delete']);
  await ensureExplorerMenu({ ...deps, packaged: true });
  assert.equal(ran.length, 8, 'removed by the person: it stays removed');
  assert.equal(await setExplorerMenu(true, { ...deps, platform: 'linux' }), false, 'Windows only');
});

test('the Team list by folder; a dropped file URL', () => {
  const agent = (id: string, name: string) => ({ id, name }) as Agent;
  const groups = folderGroups([agent('a', 'Zoe'), agent('b', 'Ben'), agent('c', 'Cleo'), agent('d', 'Dan')], [
    { agentId: 'a', folder: 'C:\\code\\shop', label: 'shop' }, { agentId: 'b', folder: 'c:\\CODE\\shop', label: 'shop' }, { agentId: 'c', folder: 'C:\\code\\api', label: 'api' },
  ]);
  assert.deepEqual(groups.map((group) => [group.label, group.agents.map((entry) => entry.name)]), [['api', ['Cleo']], ['shop', ['Ben', 'Zoe']], ['No folder', ['Dan']]]);
  assert.equal(fileUrlPath('file:///C:/code/my%20shop'), 'C:\\code\\my shop');
  assert.equal(fileUrlPath('file:///home/ada/shop'), '/home/ada/shop');
  assert.equal(fileUrlPath('https://example.com/x'), '');
});
