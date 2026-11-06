// files.pickFolder – main shows the folder dialog for the restore purpose and answers a path
// (nothing is read or uploaded).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { folderDialogOptions, folderPurpose, pickFolder } from '../../../src/main/files-pick.ts';
import type { DialogOptions } from '../../../src/main/files-pick.ts';

const badRequest = (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request';
const root = process.platform === 'win32' ? 'C:\\Backups\\one' : '/backups/one';

function dialog(answer: { canceled: boolean; filePaths: string[] }) {
  const seen: DialogOptions[] = [];
  return { seen, deps: { showOpenDialog: async (options: DialogOptions) => { seen.push(options); return answer; } } };
}

test('pickFolder: restore answers the chosen folder; cancel answers null; only the known purpose', async () => {
  const chosen = dialog({ canceled: false, filePaths: [root] });
  assert.equal(await pickFolder('restore', chosen.deps), root);
  assert.deepEqual(chosen.seen[0], { title: 'Choose an Autark backup folder', buttonLabel: 'Choose backup', properties: ['openDirectory'] });

  assert.equal(await pickFolder('restore', dialog({ canceled: true, filePaths: [root] }).deps), null);
  assert.equal(await pickFolder('restore', dialog({ canceled: false, filePaths: [] }).deps), null);
  await assert.rejects(pickFolder('anything', chosen.deps), badRequest);
  await assert.rejects(pickFolder('restore', dialog({ canceled: false, filePaths: ['relative/dir'] }).deps), badRequest);
  assert.throws(() => folderPurpose({ purpose: 'restore' }), badRequest);
  // Each call gets its own options (the table is never handed out).
  folderDialogOptions('restore').properties.push('multiSelections');
  assert.ok(!folderDialogOptions('restore').properties.includes('multiSelections'));
});
