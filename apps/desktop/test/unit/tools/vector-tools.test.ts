// vector.embed and vector.search as tools: found through tools.find (no core tool), offered in every mode, short specs,
// plain result texts; models-uses knows the use.
// Owns: these assertions only. Never: real models.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_CORE } from '../../../src/runtime/tools/core-sets.ts';
import { builtinTools } from '../../../src/runtime/tools/builtin/index.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { VectorService } from '../../../src/runtime/contracts/vectors.ts';
import { chosenFor, OFFABLE_USES, servesUse, useValue } from '../../../src/shared/model/models-uses.ts';

const tools = builtinTools();
const find = (name: string) => {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `${name} is registered`);
  return tool;
};
const textOf = (output: ToolOutput) => output.content.map((part) => ('text' in part ? part.text : '')).join('');

function ctx(vectors: Partial<VectorService>): ToolContext {
  return { services: { vectors, paths: { data: 'C:/data', workspace: process.cwd() } } } as unknown as ToolContext;
}

test('both tools are on demand, in every mode, with a short spec', () => {
  for (const name of ['vector.embed', 'vector.search']) {
    const tool = find(name);
    assert.ok(!(name in BASE_CORE));
    assert.equal(tool.anyMode, true);
    const size = tool.description.length + JSON.stringify(tool.inputSchema).length;
    assert.ok(size < 700, `${name} spec is ${size} characters`);
  }
});

test('vector.search passes memory places through, resolves files and prints hits and the note', async () => {
  let given: { query: string; in: string[]; k?: number } | undefined;
  const output = await find('vector.search').run({ query: ' invoice ', in: ['memory/company', 'C:/work/notes'], k: 3 }, ctx({
    search: async (input) => {
      given = input;
      return { hits: [{ path: 'memory/company/a.md', chunk: 0, lines: [2, 9], snippet: 'the  invoice', score: 0.612 }], searched: { places: input.in, embeddedFiles: 4 }, note: 'Nothing embedded under C:/work/notes – embed it first with vector.embed.' };
    },
  }));
  assert.equal(given?.query, 'invoice');
  assert.equal(given?.in[0], 'memory/company');
  assert.equal(given?.k, 3);
  const body = textOf(output);
  assert.match(body, /Nothing embedded under/);
  assert.match(body, /^1 hits\.$/m);
  assert.doesNotMatch(body, /embedded files/, 'no count of what is embedded in any context');
  assert.match(body, /0\.61 memory\/company\/a\.md:2-9\n {2}the invoice/);
  assert.match(body, /memory\/ is /);
});

test('vector.embed reports counts, what was left out and when to call again', async () => {
  const output = await find('vector.embed').run({ paths: ['memory'] }, ctx({
    available: () => true,
    embed: async (paths) => {
      assert.deepEqual(paths, ['memory']);
      return { embedded: 2, reembedded: 1, unchanged: 3, skipped: [{ path: 'x/node_modules', reason: 'dependencies, caches or app data' }], remaining: 5 };
    },
  }));
  const body = textOf(output);
  assert.match(body, /Embedded 2, re-embedded 1, already embedded 3/);
  assert.match(body, /x\/node_modules: dependencies/);
  assert.match(body, /5 files not finished: call vector\.embed again/);
});

test('vector.embed without a model says what to use instead', async () => {
  const output = await find('vector.embed').run({ paths: ['memory'] }, ctx({ available: () => false }));
  assert.equal(output.isError, true);
  assert.match(textOf(output), /files\.search/);
});

test('the use: auto by default, can be off, knows embedding models by name', () => {
  assert.equal(useValue({}, 'embeddings'), 'auto');
  assert.equal(useValue({ embeddings: 'off' }, 'embeddings'), 'off');
  assert.equal(chosenFor({ embeddings: 'ollama:bge-m3' }, 'embeddings'), 'ollama:bge-m3');
  assert.ok(OFFABLE_USES.has('embeddings'));
  const model = (name: string) => ({ model: name, functions: [], strengths: {} });
  assert.ok(servesUse(model('nomic-embed-text'), 'embeddings'));
  assert.ok(servesUse(model('bge-m3:latest'), 'embeddings'));
  assert.ok(servesUse(model('BAAI/bge-m3'), 'embeddings'));
  assert.ok(!servesUse(model('jina-reranker-embed'), 'embeddings'));
  assert.ok(!servesUse(model('gpt-6'), 'embeddings'));
});
