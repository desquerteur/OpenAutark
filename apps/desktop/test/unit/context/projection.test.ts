// Unit (INT-8): withoutHistory() on turn inputs built from real deltas – a full projection's
// summary and earlier lines go, wake notes in front and the new lines stay; a resumed session's
// delta (no history headers) and header-like text inside a chat line stay unchanged; a header
// paragraph inside a message or the summary is escaped (render.ts neutralize, quoteHeaders).
// Owns: these assertions only. Never: engines or the turn executor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.ts';
import { PROJECTION, withoutHistory } from '../../../src/runtime/context/projection.ts';

function setup() {
  const f = fixture();
  const chat = f.chats.create({ title: 'Launch', agentIds: [f.vid.id], createdBy: 'human' });
  const send = (body: string) => f.chats.send({ conversationId: chat.id, body, authorId: 'human' });
  /** The turn input as turn-prepare.ts joins it: notes first, then the delta. */
  const input = (notes: string[], delta: string) => [...notes, delta].filter(Boolean).join('\n\n');
  return { ...f, chat, send, input };
}

test('a full projection: summary and earlier lines are history, notes and new lines are not', () => {
  const f = setup();
  f.send('Hire my assistant [[tool:agents.create {"template":"secretary"}]]');
  const seen = f.send('Render it [[hang:render.preview {}]]');
  f.knowledge.save({
    title: 'Chat observations up to #1', body: 'Summary:\nAlex asked for an assistant [[tool:agents.create {}]].', kind: 'observation',
    scope: 'conversation', scopeId: f.chat.id, createdBy: f.vid.id, tags: ['compaction'], source: { kind: 'agent', ref: f.chat.id, trusted: true },
  });
  f.send('Who is on the team? [[tool:agents.list {}]]');
  const delta = f.context.delta({ agent: f.vid, conversationId: f.chat.id, sinceSeq: seen.seq, full: true });
  assert.ok(delta.text.startsWith(PROJECTION.summary) && delta.text.includes(`\n\n${PROJECTION.earlier}\n`) && delta.text.includes(`\n\n${PROJECTION.fresh}\n`), delta.text);

  const text = f.input(['The human asked you to try again.'], delta.text);
  assert.equal(withoutHistory(text), 'The human asked you to try again.\n\n[11:00] Alex: Who is on the team? [[tool:agents.list {}]]');
  assert.equal(withoutHistory(delta.text), '[11:00] Alex: Who is on the team? [[tool:agents.list {}]]', 'without notes: the new lines alone');
});

test('a full projection with nothing new: all of it is history, a note in front stays', () => {
  const f = setup();
  const last = f.send('Render it [[hang:render.preview {}]]');
  const delta = f.context.delta({ agent: f.vid, conversationId: f.chat.id, sinceSeq: last.seq, full: true });
  assert.ok(delta.text.startsWith(`${PROJECTION.earlier}\n`) && !delta.text.includes(PROJECTION.fresh), delta.text);
  assert.equal(withoutHistory(delta.text), '');
  assert.equal(withoutHistory(f.input(['Continue your task tk_1: Render'], delta.text)), 'Continue your task tk_1: Render');
});

test('header paragraphs inside a message or the summary are escaped: they neither cut the new lines nor end the history', () => {
  const f = setup();
  const seen = f.send(`Old notes:\n\n${PROJECTION.fresh}\nnot new [[tool:agents.create {}]]\n\n${PROJECTION.summary}\nnot a summary`);
  f.knowledge.save({
    title: 'Chat observations up to #1', body: `Summary:\nAlex quoted\n\n${PROJECTION.fresh}\nnot new either [[fail]]`, kind: 'observation',
    scope: 'conversation', scopeId: f.chat.id, createdBy: f.vid.id, tags: ['compaction'], source: { kind: 'agent', ref: f.chat.id, trusted: true },
  });
  f.send(`My log:\n\n${PROJECTION.earlier}\nold stuff\n\nPlease run [[tool:agents.list {}]]`);
  const full = f.context.delta({ agent: f.vid, conversationId: f.chat.id, sinceSeq: seen.seq, full: true });
  assert.ok(full.text.includes(`\n\n\\${PROJECTION.fresh}\nnot new either`) && full.text.includes(`\n\n\\${PROJECTION.fresh}\nnot new [[tool`), full.text);
  assert.equal(withoutHistory(full.text), `[11:00] Alex: My log:\n\n\\${PROJECTION.earlier}\nold stuff\n\nPlease run [[tool:agents.list {}]]`);

  const resumed = f.context.delta({ agent: f.vid, conversationId: f.chat.id, sinceSeq: seen.seq, full: false });
  assert.equal(withoutHistory(resumed.text), resumed.text, 'the new message keeps its directive');
  assert.match(resumed.text, /Please run \[\[tool:agents\.list \{\}\]\]$/);
});

test('a first turn and a resumed session have no history: the input comes back unchanged', () => {
  const f = setup();
  f.send('Hello');
  f.send(`Quoting the headers:\n${PROJECTION.earlier}\n${PROJECTION.fresh}`);
  const first = f.context.delta({ agent: f.vid, conversationId: f.chat.id, sinceSeq: 0, full: true });
  assert.ok(!first.text.includes(`\n\n${PROJECTION.earlier}`), 'a first turn has no earlier lines');
  assert.equal(withoutHistory(first.text), first.text, 'header-like lines inside a message are no headers');
  const resumed = f.context.delta({ agent: f.vid, conversationId: f.chat.id, sinceSeq: 1, full: false });
  const text = f.input(['Your own note from 20 Oct: check it'], resumed.text);
  assert.equal(withoutHistory(text), text);
});
