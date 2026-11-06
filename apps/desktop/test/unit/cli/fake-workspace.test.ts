// The headless runtime's --fake workspace (src/runtime/cli.ts) and the E2E fixtures that rely on it:
// with --fake and neither --workspace nor WORKFORCE_WORKSPACE the agents' files live in
// <data>/workspace – never in ~/Workforce, also when HOME/USERPROFILE point into the temp profile
// (the E2E tests do that so the runtime never sees the real home). Regression: runtime-agent-files
// and pwa-agent-files kept writing their fixtures to <temp home>/Workforce after that change, so
// the agent's media and file blocks named missing files and got no stored fileId.
// cli.ts starts a runtime on import, so its default is checked in the source (like
// compose/services-wiring.test.ts).
// Owns: these assertions only. Never: starts a runtime, touches the file system or the real home.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
const source = (file: string) => readFileSync(new URL(file, root), 'utf8');

test('--fake without a workspace option: the agents\' files are <data>/workspace', () => {
  const cli = source('src/runtime/cli.ts');
  const fallback = /\?\? \(fake \? path\.join\(dataDir, '([^']+)'\) : undefined\)/.exec(cli);
  assert.ok(fallback, 'cli.ts falls back to a folder in the data dir with --fake');
  assert.equal(fallback[1], 'workspace');
});

test('E2E tests on the --fake runtime put their workspace fixtures into <data>/workspace', () => {
  const dir = new URL('test/e2e/', root);
  const files = readdirSync(dir).filter((name) => name.endsWith('.test.mjs'));
  assert.ok(files.length > 0);
  for (const name of files) {
    const text = readFileSync(new URL(name, dir), 'utf8');
    if (!text.includes('startRuntime(') || /fake: false|WORKFORCE_WORKSPACE|--workspace/.test(text)) continue;
    assert.doesNotMatch(text, /path\.join\([^)]*'Workforce'\)/, `${name}: the --fake runtime does not read ~/Workforce`);
  }
});
