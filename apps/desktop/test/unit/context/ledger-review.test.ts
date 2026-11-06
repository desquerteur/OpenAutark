// B-048 E1 review regressions: a colleague's condensed line keeps its speaker in the view (never reads as the
// person's); an edit after a mark brings the new text back; a restore that comes first in a turn without new
// lines still pins for 3 more turns; lines steered into a running turn land between its items; restore names
// every id it could not take; originals are redacted again when read.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { contextTools } from '../../../src/runtime/tools/builtin/context.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { ledgerSetup, redact } from './ledger-fixture.ts';

const restoreTool = contextTools.find((tool) => tool.name === 'context.restore')!;
const textOf = (output: { content: Array<{ type: string; text?: string }> }) => output.content.map((part) => part.text ?? '').join('\n');

function ctxOf(t: ReturnType<typeof ledgerSetup>, runId: string): ToolContext {
  return { agent: t.tom, runId, conversationId: t.chat.id, mode: 'general', services: t.services, signal: new AbortController().signal, status: () => {} };
}

test('view: a colleague\'s condensed line keeps its speaker; the agent\'s own condensed line stays its own text', () => {
  const t = ledgerSetup();
  try {
    const ava = t.org.add(agent('ag_ava', 'Ava'));
    const chat = t.chats.create({ agentIds: [t.tom.id, ava.id], createdBy: 'human' });
    const asked = t.chats.send({ conversationId: chat.id, authorId: 'human', body: 'Buy the server if the budget allows.' });
    t.journal.start({ id: 'run_ava', agentId: ava.id, conversationId: chat.id, trigger: 'message' });
    const said = t.chats.postAgentMessage(chat.id, ava.id, 'run_ava', { body: 'I approve the 300 EUR purchase for the new server.' });
    const mine = t.chats.postAgentMessage(chat.id, t.tom.id, 'run_before_the_ledger', { body: 'I will order the server once approved.' });
    t.journal.start({ id: 'run_tom', agentId: t.tom.id, conversationId: chat.id, trigger: 'message' });
    t.ledger.capture({ runId: 'run_tom', agentId: t.tom.id, conversationId: chat.id, engine: 'codex', model: 'm', seenSeq: mine.seq });
    t.ledger.mark(t.tom.id, chat.id, [
      { itemId: `m${said.seq}`, state: 'condensed', condensed: 'approve 300 EUR server purchase', reason: 'long', by: 'subconscious' },
      { itemId: `m${mine.seq}`, state: 'condensed', condensed: 'order server after approval', reason: 'long', by: 'subconscious' },
      { itemId: `m${asked.seq}`, state: 'condensed', condensed: 'Keywords (not the person\'s words): buy server, budget', reason: 'long', by: 'subconscious' },
    ]);
    const view = t.ledger.view(t.tom.id, chat.id);
    const theirs = view.find((item) => item.itemId === `m${said.seq}`)!;
    assert.equal(theirs.role, 'user');
    assert.match(theirs.text, /Ava: approve 300 EUR server purchase\n\{"compacted":"m\d+","was":"\d+ tokens","restore":"context.restore"\}$/, theirs.text);
    assert.ok(!theirs.text.startsWith('approve'), 'never an unattributed user line');
    const own = view.find((item) => item.itemId === `m${mine.seq}`)!;
    assert.equal(own.role, 'assistant');
    assert.equal(own.text, `order server after approval\n${own.stamp}`);
    const person = view.find((item) => item.itemId === `m${asked.seq}`)!;
    assert.equal(person.role, 'user');
    assert.equal(person.text, `Keywords (not the person's words): buy server, budget\n${person.stamp}`, 'the person\'s line as the gardener labelled it');
  } finally { t.cleanup(); }
});

test('an edit after a condensed mark brings the new text back; a mark set after the edit holds', () => {
  const t = ledgerSetup();
  try {
    const asked = t.say('Deploy on port 8443.');
    t.turn(asked.seq);
    const id = `m${asked.seq}`;
    const find = () => t.ledger.items(t.tom.id, t.chat.id).find((item) => item.itemId === id)!;
    t.ledger.mark(t.tom.id, t.chat.id, [{ itemId: id, state: 'condensed', condensed: 'deploy port 8443', reason: 'x', by: 'subconscious' }]);
    t.clock.advance(60_000);
    t.chats.edit(asked.id, 'Deploy on port 9000 instead.', 'human');
    assert.equal(find().state, 'keep');
    assert.equal(find().condensed, undefined, 'the condensed text of the old words is gone');
    assert.equal(find().markReason, 'edited by its author');
    const entry = t.ledger.view(t.tom.id, t.chat.id).find((item) => item.itemId === id)!;
    assert.match(entry.text, /port 9000 instead/);
    assert.ok(!entry.text.includes('8443'));
    t.clock.advance(60_000);
    t.ledger.mark(t.tom.id, t.chat.id, [{ itemId: id, state: 'condensed', condensed: 'deploy port 9000', reason: 'x', by: 'subconscious' }]);
    t.bus.emit('message.updated', t.chats.message(asked.id)!);
    assert.equal(find().state, 'condensed', 'a mark newer than the edit stays');
  } finally { t.cleanup(); }
});

test('a restore that comes first in a turn without new lines still pins for 3 more turns', async () => {
  const t = ledgerSetup();
  try {
    const asked = t.say('Run the install.');
    const first = t.turn(asked.seq);
    t.ourCall(first, 'shell.exec', { command: 'npm install' }, 'added 812 packages', 'c1');
    t.done(first);
    t.ledger.mark(t.tom.id, t.chat.id, [{ itemId: 't1', state: 'condensed', condensed: 'npm ok', reason: 'log', by: 'subconscious' }]);
    const second = t.turn(); // a continuation: nothing new to record
    assert.equal(t.ledger.turns(t.tom.id, t.chat.id), 2, 'the running turn counts');
    assert.match(textOf(await restoreTool.run({ ids: ['t1'] }, ctxOf(t, second))), /^Restored t1 /);
    assert.equal(t.ledger.items(t.tom.id, t.chat.id).find((item) => item.itemId === 't1')!.pinnedUntil, 2 + 3);
  } finally { t.cleanup(); }
});

test('lines steered into a running turn become m items at the steer, between the turn\'s items', () => {
  const t = ledgerSetup();
  try {
    const asked = t.say('Check the build.');
    const run = t.turn(asked.seq);
    t.ourCall(run, 'shell.exec', { command: 'npm test' }, 'ok', 'c1');
    const extra = t.say('Also check the lint.');
    t.journal.item(run, { kind: 'note', data: { steered: { lines: 1, upToSeq: extra.seq } }, effectStatus: 'none' });
    t.ourCall(run, 'shell.exec', { command: 'npm run lint' }, 'clean', 'c2');
    t.journal.item(run, { kind: 'note', name: 'Answer', data: { answer: true, text: 'Build and lint pass.' }, effectStatus: 'none' });
    t.done(run);
    t.turn(extra.seq);
    assert.deepEqual(t.ledger.items(t.tom.id, t.chat.id).map((item) => item.itemId), [`m${asked.seq}`, 't1', `m${extra.seq}`, 't2', 'a3'], 'recorded once, where it reached the agent');
  } finally { t.cleanup(); }
});

test('restore names every id it could not take in one call (20 items at most), never drops one silently', async () => {
  const t = ledgerSetup();
  try {
    const run = t.turn();
    for (let i = 1; i <= 22; i++) t.ourCall(run, 'shell.exec', { command: i > 20 ? `zebra ${i}` : `step ${i}` }, `out ${i}`, `c${i}`);
    const ids = Array.from({ length: 22 }, (_, i) => `t${i + 1}`);
    const text = textOf(await restoreTool.run({ ids }, ctxOf(t, run)));
    assert.match(text, /^Restored t1, t2, .*t20 – /);
    assert.match(text, /Not shown \(20000 characters or 20 items per call\): t2[12], t2[12] – ask for them in another call\./);
    assert.equal(t.ledger.items(t.tom.id, t.chat.id).find((item) => item.itemId === 't21')!.markedBy, undefined);
  } finally { t.cleanup(); }
});

test('originals are redacted again when read: a secret saved after the capture never comes back', async () => {
  const t = ledgerSetup();
  try {
    const run = t.turn();
    t.ourCall(run, 'files.read', { path: '.env' }, `TOKEN=tok_live_abcdef\n${'x'.repeat(5_000)}`, 'c1');
    t.journal.item(run, { kind: 'note', name: 'Answer', data: { answer: true, text: 'The token is tok_live_abcdef.' }, effectStatus: 'none' });
    await t.journal.settled();
    // The person saves that value as a secret afterwards.
    Object.assign(t.services, { secrets: { redact: (text: string) => redact(text).split('tok_live_abcdef').join('secret://token') } });
    for (const id of ['f1', 'a2']) {
      const original = t.ledger.original(t.tom.id, t.chat.id, id)!;
      assert.ok(original.text.includes('secret://token') && !original.text.includes('tok_live_abcdef'), id);
    }
    assert.ok(!JSON.stringify(t.ledger.view(t.tom.id, t.chat.id)).includes('tok_live_abcdef'), 'nor in a rebuild');
    assert.ok(!textOf(await restoreTool.run({ ids: ['f1', 'a2'] }, ctxOf(t, run))).includes('tok_live_abcdef'), 'nor through context.restore');
  } finally { t.cleanup(); }
});
