// Lean tool descriptions keep what the model must know before a call: where a file tool reads and writes, and the
// pointer to a neighbour tool. Checks the file group as registered (builtinTools).
// Owns: these assertions only. Never: runs a tool.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinTools } from '../../../src/runtime/tools/builtin/index.ts';

const tools = builtinTools();
const spec = (name: string) => {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `${name} is registered`);
  return { description: tool.description, schema: JSON.stringify(tool.inputSchema) };
};

test('files.read / files.write / shell.exec say they work anywhere on this PC; a linked PC is named by device', () => {
  assert.match(spec('files.read').description, /absolute path anywhere on this PC/);
  assert.match(spec('files.write').description, /absolute path anywhere on this PC/);
  assert.match(spec('shell.exec').description, /absolute folder anywhere/);
  assert.match(spec('files.read').schema, /linked PC/);
  assert.match(spec('knowledge.find').description, /files\.search/);
});
