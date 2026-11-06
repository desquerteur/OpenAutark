// B-052 track D: the small TOML reader for Codex's config.toml (runtime/apps/import/toml.ts) – tables, dotted and
// quoted keys, strings of all four kinds with escapes, numbers, booleans, arrays and inline tables across lines,
// comments, arrays of tables, dates as text; an unreadable statement is skipped without hiding the rest, a
// duplicate key keeps the first value, and no key reaches an object's prototype.
// Owns: checks of the parser only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToml } from '../../../src/runtime/apps/import/toml.ts';

test('the Codex shapes: [mcp_servers.<name>], its env table, inline tables, arrays over several lines', () => {
  const doc = parseToml([
    'model = "gpt-5" # the default model',
    '',
    '[mcp_servers.docs]',
    'command = "uvx"',
    "args = ['mcp-server-docs', \"--port\", \"8080\",] # trailing comma",
    'env = { DOCS_TOKEN = "t-1", "QUOTED KEY" = \'x\' }',
    'startup_timeout_sec = 20',
    'enabled = true',
    '',
    '[mcp_servers."my server"]',
    'url = "https://mcp.example.com/mcp"',
    'http_headers = {',
    '  "X-Team" = "core", # inline tables over lines (TOML 1.1)',
    '}',
    '',
    '[mcp_servers.docs2]',
    'command = "node"',
    'args = [',
    '  "a", # first',
    '  "b"',
    ']',
    '[mcp_servers.docs2.env]',
    'A = "1"',
    'B = 2',
  ].join('\r\n'));
  assert.equal(doc.model, 'gpt-5');
  assert.deepEqual(doc.mcp_servers, {
    docs: { command: 'uvx', args: ['mcp-server-docs', '--port', '8080'], env: { DOCS_TOKEN: 't-1', 'QUOTED KEY': 'x' }, startup_timeout_sec: 20, enabled: true },
    'my server': { url: 'https://mcp.example.com/mcp', http_headers: { 'X-Team': 'core' } },
    docs2: { command: 'node', args: ['a', 'b'], env: { A: '1', B: 2 } },
  });
});

test('strings: escapes, unicode, literal, multi-line basic (trimmed line ends) and literal', () => {
  const doc = parseToml([
    'a = "tab\\there \\"quoted\\" \\\\ \\u00e9 \\U0001F600"',
    "b = 'C:\\no\\escapes'",
    'c = """',
    'first \\',
    '    second"""',
    "d = '''",
    'raw \\n line',
    "two'''",
    'e = """ends with ""quotes"""""',
  ].join('\n'));
  assert.equal(doc.a, 'tab\there "quoted" \\ é 😀');
  assert.equal(doc.b, 'C:\\no\\escapes');
  assert.equal(doc.c, 'first second');
  assert.equal(doc.d, 'raw \\n line\ntwo');
  assert.equal(doc.e, 'ends with ""quotes""', 'up to two quotes before the closing ones belong to the text');
});

test('numbers, booleans, dates as text, dotted keys, arrays of tables', () => {
  const doc = parseToml([
    'int = +1_000', 'neg = -17', 'hex = 0xff', 'oct = 0o17', 'bin = 0b101', 'float = 6.02e23', 'frac = -0.5', 'inf = inf',
    'yes = true', 'no = false', 'when = 1979-05-27 07:32:00Z', 'day = 1979-05-27', 'site."google.com".port = 443',
    '[[servers]]', 'name = "one"', '[[servers]]', 'name = "two"', '[servers.extra]', 'x = 1',
  ].join('\n'));
  assert.deepEqual([doc.int, doc.neg, doc.hex, doc.oct, doc.bin, doc.float, doc.frac, doc.inf], [1000, -17, 255, 15, 5, 6.02e23, -0.5, Infinity]);
  assert.deepEqual([doc.yes, doc.no, doc.when, doc.day], [true, false, '1979-05-27 07:32:00Z', '1979-05-27']);
  assert.deepEqual(doc.site, { 'google.com': { port: 443 } });
  assert.deepEqual(doc.servers, [{ name: 'one' }, { name: 'two', extra: { x: 1 } }]);
});

test('tolerant: a broken statement is skipped, the rest stays; a duplicate keeps the first; no prototype keys', () => {
  const doc = parseToml([
    'good = 1',
    'broken = "no end',
    'bare = word',
    '= 3',
    '[mcp_servers.a]',
    'command = "a"',
    'command = "second"',
    'args = [ "x", nope ]',
    '__proto__ = { polluted = true }',
    '[__proto__]',
    'polluted = true',
    '[mcp_servers.b]',
    'command = "b"',
  ].join('\n'));
  assert.equal(doc.good, 1);
  assert.deepEqual(doc.mcp_servers, { a: { command: 'a', polluted: true }, b: { command: 'b' } }, 'the broken header leaves the next keys in the table before it');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf(doc), Object.prototype);
  assert.deepEqual(parseToml(''), {});
  assert.deepEqual(parseToml('\uFEFF# only a comment'), {});
});
