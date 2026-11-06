// A connector's MCP tool as a Workforce tool – names (cleaned, ≤ 44 with a stable hash, unique within the app, never a
// '__' of their own), descriptions ("<App>: …", cleaned, clipped) and input schemas (local $ref inlined, cycles and
// remote refs → {}, an object schema, texts cleaned, a huge one not offered).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_TOOL_NAME_MAX, APP_TOOL_PREFIX, appToolDescription, appToolName, appToolNames, appToolSchema, toolPart } from '../../../src/runtime/apps/tools-schema.ts';

const REGISTRY_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;
/** What Claude sees: mcp__workforce__ + the wire name (each '.' → '__'). */
const claudeName = (name: string) => `mcp__workforce__${name.replace(/\./g, '__')}`;

test('names: app.<id>.<tool>, camelCase split, lowercased, other characters → _, no separator runs or edges', () => {
  assert.equal(APP_TOOL_PREFIX, 'app.');
  assert.equal(appToolName('notion', 'notion-search'), 'app.notion.notion-search');
  assert.equal(appToolName('atlassian', 'getJiraIssue'), 'app.atlassian.get_jira_issue');
  assert.equal(appToolName('acme', 'Search Pages!'), 'app.acme.search_pages');
  assert.equal(appToolName('acme', '__weird..name__'), 'app.acme.weird_name');
  assert.equal(appToolName('acme', 'a_-b--c'), 'app.acme.a_b-c');
  assert.equal(appToolName('acme', '日本'), 'app.acme.tool');
  assert.equal(toolPart('send.email'), 'send_email');
  for (const raw of ['x__y', '_a_', 'a.b.c', 'A__B__C', 'tool name with spaces']) {
    const name = appToolName('acme', raw);
    assert.match(name, REGISTRY_NAME);
    assert.ok(!name.slice(APP_TOOL_PREFIX.length).includes('__'), `${raw}: no "__" of its own`);
  }
});

test('names: a long one keeps its start plus a stable 6-character hash, within Claude\'s 64', () => {
  const id = 'abcdefghijklmnopqrstuvwx'; // the longest app id (24)
  const long = appToolName(id, 'create_a_really_long_database_entry_with_properties');
  assert.ok(long.length <= APP_TOOL_NAME_MAX, long);
  assert.match(long, /^app\.abcdefghijklmnopqrstuvwx\.[a-z0-9_-]+_[0-9a-f]{6}$/);
  assert.equal(appToolName(id, 'create_a_really_long_database_entry_with_properties'), long, 'stable');
  assert.notEqual(appToolName(id, 'create_a_really_long_database_entry_with_other_things'), long, 'another MCP name, another hash');
  assert.ok(claudeName(long).length <= 64);
  assert.match(long, REGISTRY_NAME);
  const short = appToolName('notion', 'search');
  assert.equal(short, 'app.notion.search', 'short names stay plain');
  assert.equal(appToolName('acme', 'x'.repeat(35)), `app.acme.${'x'.repeat(35)}`, 'exactly at the limit (44): plain');
  assert.match(appToolName('acme', 'x'.repeat(36)), /^app\.acme\.x+_[0-9a-f]{6}$/, 'one over: hashed');
  assert.equal(appToolName('acme', 'x'.repeat(36)).length, 44);
});

test('names: collisions within an app – the canonical one keeps the plain name, the others get a hash; duplicates and junk drop', () => {
  const names = appToolNames('acme', ['getIssue', 'get_issue', 'GET_ISSUE', 'get_issue', '', 7, null, 'list']);
  assert.equal(names.get('get_issue'), 'app.acme.get_issue');
  assert.match(names.get('getIssue')!, /^app\.acme\.get_issue_[0-9a-f]{6}$/);
  assert.match(names.get('GET_ISSUE')!, /^app\.acme\.get_issue_[0-9a-f]{6}$/);
  assert.notEqual(names.get('getIssue'), names.get('GET_ISSUE'));
  assert.equal(names.get('list'), 'app.acme.list');
  assert.equal(names.size, 4);
  assert.equal(new Set(names.values()).size, 4, 'unique');
  // Without a canonical member, the first by MCP name keeps it (order of the list does not matter).
  const a = appToolNames('acme', ['Get Page', 'GET PAGE']);
  const b = appToolNames('acme', ['GET PAGE', 'Get Page']);
  assert.deepEqual([...a].sort(), [...b].sort());
  assert.equal(a.get('GET PAGE'), 'app.acme.get_page');
  assert.match(a.get('Get Page')!, /^app\.acme\.get_page_[0-9a-f]{6}$/);
});

test('descriptions: "<App>: title. description", cleaned and clipped to 400', () => {
  assert.equal(appToolDescription('Notion', { name: 'search', title: 'Search', description: 'Find pages and databases.', inputSchema: {} }), 'Notion: Search. Find pages and databases.');
  assert.equal(appToolDescription('Notion', { name: 'search', title: 'Search', description: 'Search the workspace.', inputSchema: {} }), 'Notion: Search the workspace.', 'no repeated title');
  assert.equal(appToolDescription('Linear', { name: 'list_issues', inputSchema: {} }), 'Linear: list_issues');
  assert.equal(appToolDescription('Acme', { name: 'x', description: '<b>Bold</b> [docs](https://x.test)​ text\n\nmore', inputSchema: {} }), 'Acme: Bold docs text more');
  assert.equal(appToolDescription('Acme', { name: 'x', annotations: { title: 'From annotations' }, inputSchema: {} }), 'Acme: From annotations');
  const long = appToolDescription('Acme', { name: 'x', description: 'word '.repeat(200), inputSchema: {} })!;
  assert.equal(long.length, 400);
  assert.ok(long.endsWith('…'));
});

test('descriptions: invisible characters go, every tool is offered', () => {
  const tool = (description: string) => appToolDescription('Acme', { name: 'notes', description, inputSchema: {} });
  assert.equal(tool('Lists the notes of a​ project.'), 'Acme: Lists the notes of a project.');
});

test('schemas: local $ref inlined from $defs and definitions; $schema, $id, $defs and examples dropped', () => {
  const schema = appToolSchema({
    $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'urn:x', type: 'object',
    properties: { page: { $ref: '#/$defs/Page', description: 'the page' }, tags: { type: 'array', items: { $ref: '#/definitions/Tag' } } },
    required: ['page', 5], examples: [{ page: {} }],
    $defs: { Page: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    definitions: { Tag: { type: 'string', enum: ['a', 'b'] } },
  })!;
  assert.deepEqual(schema, {
    type: 'object',
    properties: {
      page: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], description: 'the page' },
      tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
    },
    required: ['page'],
  });
});

test('schemas: cycles and remote refs become {}, deep chains stop; always an object schema', () => {
  const cyclic = appToolSchema({ type: 'object', properties: { node: { $ref: '#/$defs/Node' } }, $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } } })!;
  const node = (cyclic.properties as Record<string, Record<string, unknown>>).node;
  assert.deepEqual(node, { type: 'object', properties: { child: {} } });
  assert.deepEqual(appToolSchema({ type: 'object', properties: { x: { $ref: 'https://evil.test/schema.json' } } }), { type: 'object', properties: { x: {} } });
  assert.deepEqual(appToolSchema({ type: 'object', properties: { x: { $ref: '#/$defs/Missing' } } }), { type: 'object', properties: { x: {} } });
  const defs: Record<string, unknown> = {};
  for (let i = 0; i < 12; i++) defs[`D${i}`] = { type: 'object', properties: { next: { $ref: `#/$defs/D${i + 1}` } } };
  const deep = JSON.stringify(appToolSchema({ type: 'object', properties: { start: { $ref: '#/$defs/D0' } }, $defs: defs }));
  assert.ok((deep.match(/"next"/g) ?? []).length <= 8, 'at most 8 refs deep');
  assert.deepEqual(appToolSchema(undefined), { type: 'object', properties: {} });
  assert.deepEqual(appToolSchema('nope'), { type: 'object', properties: {} });
  assert.deepEqual(appToolSchema({ properties: [] }), { type: 'object', properties: {} });
  assert.deepEqual(appToolSchema({ $ref: '#/$defs/Args', $defs: { Args: { type: 'object', properties: { q: { type: 'string' } } } } }), { type: 'object', properties: { q: { type: 'string' } } }, 'a root $ref');
});

test('schemas: keywords are read by structure – a property may be called "description" or "$ref"', () => {
  const schema = appToolSchema({ type: 'object', properties: { description: { type: 'string', description: ' The​ text ' }, $ref: { type: 'string' }, title: { type: 'string' } }, additionalProperties: false })!;
  assert.deepEqual(schema, { type: 'object', properties: { description: { type: 'string', description: 'The text' }, $ref: { type: 'string' }, title: { type: 'string' } }, additionalProperties: false });
  const long = appToolSchema({ type: 'object', properties: { q: { type: 'string', description: 'x'.repeat(1000) } } })!;
  assert.equal(((long.properties as Record<string, Record<string, string>>).q.description).length, 300);
});

test('schemas: a huge schema means the tool is not offered', () => {
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < 2000; i++) properties[`field_${i}`] = { type: 'string', description: 'A field with a fairly long description text.' };
  assert.equal(appToolSchema({ type: 'object', properties }), undefined);
});
