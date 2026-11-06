import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createPaths, engineCwd, ensurePaths } from '../../../src/runtime/system/paths.ts';
import { FileLogger, redact } from '../../../src/runtime/system/log.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { tempDir } from './helpers.ts';

test('paths: layout under data, default workspace under home, directories created', () => {
  const { dir, cleanup } = tempDir();
  try {
    const paths = ensurePaths(createPaths({ data: path.join(dir, 'data'), resources: path.join(dir, 'res'), home: path.join(dir, 'home') }));
    assert.equal(paths.blobs, path.join(dir, 'data', 'blobs'));
    assert.equal(paths.workspace, path.join(dir, 'home', 'Workforce'));
    for (const key of ['data', 'workspace', 'blobs', 'accounts', 'logs', 'temp'] as const) assert.ok(existsSync(paths[key]), key);
    assert.equal(existsSync(path.join(dir, 'data', 'custom')), false, 'the old overlay folder is no longer created');
    assert.ok(existsSync(engineCwd(paths)), 'the empty engine folder (engine processes start there)');
    assert.ok(!existsSync(paths.resources));
    const custom = createPaths({ data: dir, resources: dir, workspace: path.join(dir, 'ws') });
    assert.equal(custom.workspace, path.join(dir, 'ws'));
  } finally { cleanup(); }
});

test('logger: JSON lines, redaction, size-capped rotation', () => {
  const { dir, cleanup } = tempDir();
  try {
    const log = new FileLogger({ dir, clock: new ManualClock(), maxBytes: 400, keep: 2 });
    log.info('hello', { apiKey: 'sk-secret', nested: { token: 'abc', ok: 1 } });
    const first = JSON.parse(readFileSync(path.join(dir, 'runtime.log'), 'utf8').trim());
    assert.equal(first.msg, 'hello');
    assert.equal(first.data.apiKey, '[redacted]');
    assert.equal(first.data.nested.token, '[redacted]');
    assert.equal(first.data.nested.ok, 1);
    for (let index = 0; index < 30; index++) log.warn(`line ${index}`, { index });
    log.debug('not written at info level');
    log.close();
    const files = readdirSync(dir).sort();
    assert.deepEqual(files, ['runtime.1.log', 'runtime.2.log', 'runtime.log']);
    for (const file of files) assert.ok(readFileSync(path.join(dir, file)).length <= 400);
    assert.ok(!readFileSync(path.join(dir, 'runtime.log'), 'utf8').includes('not written'));
  } finally { cleanup(); }
});

test('redact caps long strings and keeps booleans of secret-named keys', () => {
  const value = redact({ hasKey: true, text: 'x'.repeat(5000) }) as { hasKey: boolean; text: string };
  assert.equal(value.hasKey, true);
  assert.ok(value.text.length < 2100);
});
