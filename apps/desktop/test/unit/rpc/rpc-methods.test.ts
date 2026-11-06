// rpc.methods: every method of the finished table with who may call it, and the params the build reads from the contract as text
// (scripts/rpc-docs.mjs), because a packaged app has no source.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { blankComments, methodsIn, readDocs, typesIn } from '../../../scripts/rpc-docs.mjs';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { methodList } from '../../../src/runtime/rpc/handlers/rpc-methods.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');

test('the scan reads params and comments as the contract writes them', () => {
  const source = `
export interface Methods {
  /** First line.
   *  Second line. */
  'a.one': { params: { id: string; deep: { x: Array<{ y: number }> } }; result: { ok: true } };
  'a.two': { params: Partial<Foo> & { name: string } | void; result: Bar }; // beside it
  // ------------------ a heading
  'a.three': { params: void; result: Record<string, { a: () => void }> };
  /** B-041: its build label goes. */
  'a.four': { params: { text: '}' }; result: 1 };
}`;
  assert.deepEqual(methodsIn(source), {
    'a.one': { params: '{ id: string; deep: { x: Array<{ y: number }> } }', note: 'First line. Second line.' },
    'a.two': { params: 'Partial<Foo> & { name: string } | void', note: 'beside it' },
    'a.three': { params: 'void' },
    'a.four': { params: "{ text: '}' }", note: 'its build label goes.' },
  });
});

test('a type declared twice is both texts; a comment never counts as a bracket', () => {
  assert.equal(blankComments('a /* { */ b // }\nc').replace(/\s+/g, ' '), 'a b c');
  const types = typesIn('export interface In { a: string; /* } */ }\nexport type Kind = \'x\' | \'y\';\nexport interface In { b: number }\n');
  assert.equal(types.Kind, "type Kind = 'x' | 'y'");
  assert.match(types.In, /a: string;.*&.*b: number/);
});

test('every method of the table has its params in the contract; the whole list leaves out the types', async () => {
  const table = createHandlerTable();
  const docs = await readDocs(ROOT);
  const missing = table.methods().filter((name) => !docs.methods[name]);
  assert.deepEqual(missing, []);
  const { methods, types } = methodList(table);
  assert.equal(methods.length, table.methods().length);
  assert.equal(types, undefined, 'the whole list leaves the types out');
});

test('match narrows the list and spells out the types; who may call is the table\'s rule', () => {
  const table = createHandlerTable();
  const { methods, types } = methodList(table, 'messages.send');
  const send = methods.find((method) => method.name === 'messages.send');
  assert.equal(send?.params, 'SendMessageInput');
  assert.equal(send?.connector, true, 'a connector token reaches it');
  assert.match(types?.SendMessageInput ?? '', /conversationId: string/);
  assert.match(types?.SendMessageInput ?? '', /silent\?: boolean/, 'with what later declarations add');
  assert.ok(types?.Attachment, 'and the types those use');
  assert.equal(methodList(table, 'files.openPath').methods[0].who, 'owner');
  assert.equal(methodList(table, 'files.readPath').methods[0].who, 'manage', "B-076: the phone's pane reads the PC's files");
  assert.equal(methodList(table, 'rpc.methods').methods[0].who, 'any');
});
