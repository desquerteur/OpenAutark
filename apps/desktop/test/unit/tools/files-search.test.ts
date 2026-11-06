// files.search (tools/builtin/files-search.ts), F2 (01.11.2026): without a path it searches the workspace, then the
// person's home folder – without the home's app data folders, dependency folders, hidden entries and (inside files)
// OneDrive; a workspace inside the home is not searched twice; a path keeps the search there; a single file is searched
// inside.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { searchTool } from '../../../src/runtime/tools/builtin/files-search.ts';
import type { ToolOutput } from '../../../src/runtime/tools/types.ts';

function world(options: { workspaceInHome?: boolean; noHome?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-files-search-'));
  const home = path.join(dir, 'home');
  const workspace = options.workspaceInHome === false ? path.join(dir, 'workspace') : path.join(home, 'Workforce');
  const put = (rel: string, body = 'x\n') => { const file = path.join(home, rel); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, body); };
  mkdirSync(workspace, { recursive: true });
  mkdirSync(path.join(workspace, 'notes'), { recursive: true });
  writeFileSync(path.join(workspace, 'notes', 'plan-alpha.md'), 'Alpha target in the workspace\n');
  put(path.join('Documents', 'Projekt Alpha', 'alpha-brief.md'), 'Intro\nThe Alpha target: three clients\n');
  put(path.join('AppData', 'Local', 'cache', 'alpha-cache.txt'), 'Alpha target cached\n');
  put(path.join('Library', 'Caches', 'alpha-lib.txt'), 'Alpha target cached\n');
  put(path.join('Projekte', 'site', 'node_modules', 'alpha-pkg', 'index.js'), '// Alpha target\n');
  put(path.join('Projekte', 'site', '.git', 'alpha-ref'), 'Alpha target\n');
  put(path.join('OneDrive', 'alpha-cloud.md'), 'Alpha target in the cloud\n');
  const tool = searchTool({ resolve: async (_ctx, given) => path.resolve(workspace, given ?? '.'), home: () => (options.noHome ? path.join(dir, 'missing') : home) });
  const ctx = { services: { paths: { workspace }, secrets: { redact: (value: string) => value } }, signal: new AbortController().signal } as never;
  const run = async (args: Record<string, unknown>) => {
    const out = await tool.run(args as never, ctx) as ToolOutput;
    return { error: out.isError === true, lines: out.content.map((part) => ('text' in part ? part.text : '')).join('').split('\n') };
  };
  return { dir, home, workspace, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('without a path: the workspace first, then the home folder – app data, dependency and hidden folders left out, the workspace once', async () => {
  const w = world();
  try {
    const { error, lines } = await w.run({ query: 'alpha' });
    assert.equal(error, false, lines.join('\n'));
    assert.equal(lines[0], `4 hits for "alpha" in names below the workspace and ${w.home}:`);
    assert.equal(lines[1], 'notes/plan-alpha.md', 'the workspace first, relative');
    assert.deepEqual(lines.slice(2, 5).sort(), [
      path.join(w.home, 'Documents', 'Projekt Alpha', 'alpha-brief.md'),
      `${path.join(w.home, 'Documents', 'Projekt Alpha')}/`,
      path.join(w.home, 'OneDrive', 'alpha-cloud.md'),
    ].sort(), lines.join('\n'));
    const text = lines.join('\n');
    for (const absent of ['alpha-cache', 'alpha-lib', 'alpha-pkg', 'alpha-ref', 'Workforce']) assert.ok(!text.includes(absent), `not searched: ${absent}`);
    assert.match(lines.at(-1)!, /^Looked at \d+ entries\.$/);
  } finally { w.cleanup(); }
});

test('without a path, inside files: the home is searched too, but not its OneDrive (reading a cloud-only file downloads it)', async () => {
  const w = world({ workspaceInHome: false });
  try {
    const { lines } = await w.run({ query: 'alpha target', content: true });
    assert.equal(lines[0], `2 hits for "alpha target" inside files below the workspace and ${w.home}:`);
    assert.equal(lines[1], 'notes/plan-alpha.md:1: Alpha target in the workspace');
    assert.equal(lines[2], `${path.join(w.home, 'Documents', 'Projekt Alpha', 'alpha-brief.md')}:2: The Alpha target: three clients`);
    assert.ok(!lines.join('\n').includes('OneDrive'));
  } finally { w.cleanup(); }
});

test('a path keeps the search there: the workspace alone names the home as the wider place; the home as path skips its app data', async () => {
  const w = world();
  try {
    const only = await w.run({ query: 'brief', path: '.' });
    assert.equal(only.lines[0], 'No name matches "brief" below the workspace.');
    assert.equal(only.lines.at(-1), `That was only the workspace. This whole PC is mine to search – e.g. path "${w.home}".`);
    const docs = await w.run({ query: 'alpha', path: path.join(w.home, 'Documents') });
    assert.equal(docs.lines[0], `2 hits for "alpha" in names below ${path.join(w.home, 'Documents')}:`);
    const home = (await w.run({ query: 'alpha', path: w.home })).lines.join('\n');
    assert.ok(home.includes('alpha-brief.md') && home.includes('notes/plan-alpha.md'), home);
    assert.ok(!home.includes('alpha-cache') && !home.includes('alpha-lib'), home);
    const appData = await w.run({ query: 'alpha', path: path.join(w.home, 'AppData') });
    assert.match(appData.lines.join('\n'), /alpha-cache\.txt/, 'named as path, app data is searched');
    const file = await w.run({ query: 'clients', path: path.join(w.home, 'Documents', 'Projekt Alpha', 'alpha-brief.md') });
    assert.match(file.lines[0], /^1 line of .*alpha-brief\.md contain "clients":$/);
  } finally { w.cleanup(); }
});

test('without a path and without a home folder: the workspace alone, with the hint', async () => {
  const w = world({ noHome: true });
  try {
    const { error, lines } = await w.run({ query: 'nothing-like-this' });
    assert.equal(error, false);
    assert.equal(lines[0], 'No name matches "nothing-like-this" below the workspace.');
    assert.match(lines.at(-1)!, /^That was only the workspace\./);
    assert.equal((await w.run({ query: 'plan' })).lines[1], 'notes/plan-alpha.md');
  } finally { w.cleanup(); }
});
