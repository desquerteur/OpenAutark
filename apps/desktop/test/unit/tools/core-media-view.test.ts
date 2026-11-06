// B-058 i1 (G10): a saved mode whose patterns name media.* is offered media.view directly (FAMILY_CORE.media) – every
// image line the context does not attach names it. Built-in modes keep their own cores (MODE_CORE); whether a mode
// allows media.view at all is the registry's rule (tools/registry.ts): it comes with files.read (COMPANION_TOOLS).
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coreNames, coreReason } from '../../../src/runtime/tools/core-sets.ts';

test('a saved media mode gets media.view directly, with its reason; a saved mode without media.* does not', () => {
  const media = { key: 'my-media-mode', tools: ['media.*', 'files.*'] };
  assert.ok(coreNames(media).has('media.view'));
  assert.match(coreReason(media, 'media.view') ?? '', /media\.view/);
  for (const name of ['media.search', 'media.look']) assert.ok(coreNames(media).has(name), `${name} stays`);
  const files = { key: 'my-files-mode', tools: ['files.*'] };
  assert.equal(coreNames(files).has('media.view'), false);
  assert.equal(coreNames({ key: 'my-negated', tools: ['!media.*', 'files.*'] }).has('media.view'), false, 'a negated pattern names no family');
});

test('B-058 G10: media.view is offered in every mode, so the built-in modes without media.* can see an image', async () => {
  const { Registry } = await import('../../../src/runtime/tools/registry.ts');
  const { mediaView } = await import('../../../src/runtime/tools/builtin/media-view.ts');
  const registry = new Registry({ services: () => ({}) as never });
  registry.register(mediaView as never);
  registry.register({ name: 'files.read', description: 'read a file', inputSchema: { type: 'object' }, category: 'files', describe: () => ({ summary: 'read', resource: 'file', reversible: true, external: false }), run: async () => ({ content: [] }) } as never);
  const agent = { id: 'ag_1', name: 'Ada', mode: 'research' } as never;
  const mode = (key: string, tools: string[]) => ({ key, name: key, description: '', skills: [], tools, category: 'general', instructions: '' }) as never;
  const offers = (tools: string[], key = 'research') => registry.specsFor(agent, mode(key, tools)).some((spec) => spec.name === 'media.view');
  for (const key of ['research', 'writing', 'browser', 'computer', 'web', 'finance']) assert.ok(offers(['files.*', 'tasks.*'], key), `${key} sees images`);
  assert.ok(offers(['tasks.*']), 'every mode sees images (registry EVERY_MODE)');
  assert.ok(offers(['media.*']), 'a media mode as before');
});
