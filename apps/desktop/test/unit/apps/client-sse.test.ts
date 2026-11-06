// B-052 track A: the text/event-stream parser of the MCP client and the WWW-Authenticate reader – line ends (CRLF,
// LF, CR, split across chunks), multi-line data, comments, fields, BOM, the last event without a blank line, the size
// cap; Bearer parameters quoted and unquoted, several challenges, the 401/403 decision.
// Owns: checks of runtime/apps/client/sse.ts and client/challenge.ts only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseParser } from '../../../src/runtime/apps/client/sse.ts';
import { authChallenge, bearerParams, parseChallenges } from '../../../src/runtime/apps/client/challenge.ts';
import { McpAuthRequired } from '../../../src/runtime/apps/types.ts';

function feed(chunks: string[]) {
  const parser = new SseParser();
  const events = chunks.flatMap((chunk) => parser.push(chunk));
  return { events: [...events, ...parser.end()], parser };
}

test('events: data lines join with newlines, one leading space dropped, event/id/retry fields, comments ignored', () => {
  const { events } = feed([': hello\n', 'event: message\nid: 7\nretry: 1500\ndata:  two spaces\ndata:b\n\n', 'data\n\n', 'event: other\ndata: x\n\n']);
  assert.deepEqual(events, [
    { event: 'message', data: ' two spaces\nb', id: '7', retry: 1500 },
    { event: 'message', data: '', id: '7', retry: 1500 },
    { event: 'other', data: 'x', id: '7', retry: 1500 },
  ]);
});

test('line ends: CRLF split between chunks, a lone CR, LF; text split mid-field; a BOM at the start', () => {
  const { events } = feed(['﻿data: {"a"', ':1}\r', '\n\r', '\ndata: two\rdata: lines\r\r', 'data: lf\n', '\n']);
  assert.deepEqual(events.map((event) => event.data), ['{"a":1}', 'two\nlines', 'lf']);
});

test('the last event without its blank line still counts; blocks without data are no events', () => {
  const { events } = feed(['id: 1\n\n', 'event: x\n\n', 'data: tail']);
  assert.deepEqual(events, [{ event: 'message', data: 'tail', id: '1' }]);
});

test('an id with a NUL is ignored, a non-numeric retry too, unknown fields are skipped', () => {
  const { events } = feed(['id: a\u0000b\nretry: soon\nfoo: bar\ndata: ok\n\n']);
  assert.deepEqual(events, [{ event: 'message', data: 'ok' }]);
});

test('an event larger than the cap is dropped and counted; the stream goes on', () => {
  const parser = new SseParser(32);
  const events = [...parser.push(`data: ${'x'.repeat(40)}\n\n`), ...parser.push('data: small\n\n'), ...parser.push(`data: ${'y'.repeat(50)}`), ...parser.push('\n\ndata: after\n\n')];
  assert.deepEqual(events.map((event) => event.data), ['small', 'after']);
  assert.equal(parser.dropped, 2);
});

test('WWW-Authenticate: Bearer parameters, quoted with escapes or plain, from several challenges', () => {
  assert.deepEqual(bearerParams('Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource", scope="files:read files:write", error="invalid_token"'), {
    resourceMetadata: 'https://mcp.example/.well-known/oauth-protected-resource', scope: 'files:read files:write', error: 'invalid_token',
  });
  assert.deepEqual(bearerParams('Basic realm="old", Bearer error=insufficient_scope, scope=admin'), { error: 'insufficient_scope', scope: 'admin' });
  assert.deepEqual(bearerParams('bearer realm="a \\"quoted\\" realm", Scope="x y"'), { scope: 'x y' });
  assert.deepEqual(bearerParams('Negotiate abc/def==, Bearer resource_metadata=https://x.example/prm'), { resourceMetadata: 'https://x.example/prm' });
  assert.deepEqual(bearerParams(''), {});
  assert.deepEqual(bearerParams('Bearer'), {});
  assert.deepEqual(bearerParams('Bearer error="unterminated'), {});
  const challenges = parseChallenges('Basic realm="r", Bearer scope="s", error="e"');
  assert.deepEqual(challenges.map((challenge) => challenge.scheme), ['basic', 'bearer']);
  assert.equal(challenges[1].params.get('error'), 'e');
  assert.equal(bearerParams('Bearer __proto__="x", constructor="y", scope="ok"').scope, 'ok');
});

test('401 always needs a sign-in; 403 only with insufficient_scope; other statuses are no challenge', () => {
  const signIn = authChallenge(401, null);
  assert.ok(signIn instanceof McpAuthRequired);
  assert.equal(signIn.status, 401);
  assert.equal(signIn.message, 'The app needs a sign-in.');
  const more = authChallenge(403, 'Bearer error="insufficient_scope", scope="a b"');
  assert.equal(more?.status, 403);
  assert.equal(more?.scope, 'a b');
  assert.equal(more?.message, 'The app needs more access.');
  assert.equal(authChallenge(403, 'Bearer error="invalid_token"'), undefined);
  assert.equal(authChallenge(403, null), undefined);
  assert.equal(authChallenge(500, 'Bearer'), undefined);
  assert.equal(authChallenge(401, 'Bearer scope="a\u0000b"')?.scope, 'ab', 'control characters removed');
});
