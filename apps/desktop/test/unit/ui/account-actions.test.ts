// B-072 (owner 04.11.2026: fallback switches for all models or one provider are nonsense, the system handles it):
// Settings › Models has no pay-per-use fallback row, no plan role texts and no "Use in rotation" item; Move up / down
// stays, and the AI still sets rotation through accounts.update (named in skill ai-providers). The row files are .tsx,
// so this reads their source.
// Owns: nothing in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (file: string) => readFileSync(path.join(app, file), 'utf8');

test('no fallback knobs in Settings › Models; the order stays, rotation stays one call away for the AI', () => {
  const ui = ['src/ui/settings/AccountRow.tsx', 'src/ui/settings/account-actions.ts', 'src/ui/settings/ModelUses.tsx', 'src/ui/settings/sections.ts'].map(read).join('\n');
  for (const gone of ['Use in rotation', 'Used first', 'Backup – used', 'Not used automatically', 'Pay-per-use fallback', 'ROLE_TEXT', "'pay-per-use'", "'paid fallback'"]) {
    assert.ok(!ui.includes(gone), `"${gone}" is gone`);
  }
  assert.match(read('src/ui/settings/AccountRow.tsx'), /label: 'Move up'.*label: 'Move down'/);
  assert.match(read('resources/skills/ai-providers/SKILL.md'), /accounts\.update '\{"id":"<account>","rotation":true\}'/);
});
