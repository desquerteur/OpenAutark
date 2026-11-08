// AF-018: the projects.* RPC methods end to end over the in-memory server – add, list, rename, pin, remove – plus the
// pure helpers (ids, titles, order) of runtime/projects/service.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { folderKey, projectId, sortProjects, titleFrom } from '../../../src/runtime/projects/service.ts';
import type { Project } from '../../../src/shared/model/project.ts';
import { OWNER, PHONE, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';

test('the same folder always gives the same id, whatever its spelling', () => {
  const dir = path.resolve('some', 'folder');
  assert.equal(projectId(dir), projectId(dir + path.sep));
  if (process.platform === 'win32') assert.equal(projectId(dir.toUpperCase()), projectId(dir));
  assert.match(projectId(dir), /^prj_[0-9a-f]{16}$/);
  assert.equal(folderKey(dir + path.sep), folderKey(dir));
});

test('titleFrom takes the first non-empty line and shortens it', () => {
  assert.equal(titleFrom('\n  Fix the login  \nmore'), 'Fix the login');
  const long = titleFrom('x'.repeat(200));
  assert.ok(long.length <= 60);
  assert.ok(long.endsWith('…'));
});

test('sortProjects: pinned first, then newest activity, then name', () => {
  const p = (name: string, pinned: boolean, lastActiveAt: number) => ({ name, pinned, lastActiveAt }) as Project;
  const order = sortProjects([p('b', false, 5), p('a', false, 5), p('c', true, 1), p('d', false, 9)]).map((x) => x.name);
  assert.deepEqual(order, ['c', 'd', 'a', 'b']);
});

test('projects.add / list / update / remove over RPC, owner only', async () => {
  const fx = rpcFixture({ table: createHandlerTable() });
  try {
    const folder = path.join(fx.paths.workspace, 'demo-project');
    mkdirSync(folder, { recursive: true });
    const owner = new TestClient(fx.server, OWNER);

    const added = await owner.call<Project>('projects.add', { folder });
    assert.equal(added.name, 'demo-project');
    assert.equal(added.source, 'added');
    assert.equal(added.id, projectId(folder));
    const again = await owner.call<Project>('projects.add', { folder });
    assert.equal(again.id, added.id, 'adding a folder again returns the same project');

    let list = await owner.call<Project[]>('projects.list');
    assert.equal(list.filter((x) => x.id === added.id).length, 1);

    const renamed = await owner.call<Project>('projects.update', { id: added.id, name: 'Demo', pinned: true });
    assert.equal(renamed.name, 'Demo');
    assert.equal(renamed.pinned, true);
    const reset = await owner.call<Project>('projects.update', { id: added.id, name: '' });
    assert.equal(reset.name, 'demo-project');

    assert.deepEqual(await owner.call('projects.remove', { id: added.id }), { ok: true });
    list = await owner.call<Project[]>('projects.list');
    assert.equal(list.some((x) => x.id === added.id), false);

    const phone = new TestClient(fx.server, PHONE);
    const refused = await phone.request('projects.list');
    assert.ok(refused.error, 'a phone link may not list the folders of this PC');
  } finally {
    fx.cleanup();
  }
});
