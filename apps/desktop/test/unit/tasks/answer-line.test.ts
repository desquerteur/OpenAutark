// B-076 (owner 05.11.2026: "das ist nicht eine Entscheidung, das ist einfach nur der Button-Klick"): a click on an ask
// block is the person's own line. In the chat it appears once – their message with the picked option's text in full,
// a reply to the asking message, no "Done: <question>" line beside it; the agent that asked is woken once, as for a
// typed line (on the open task the to-do is a step of), and reads that line like any other – no [ui-answer] tag or
// note, no "[task …]" of the to-do, no second word about the step. A block without a to-do ("todo": false) reads
// the same; a form answers in "Label: value" lines.
// Owns: these assertions only. Never: real engines, timers or the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMessages } from '../../../src/runtime/context/render.ts';
import { uiBlocksOf } from '../../../src/shared/blocks/parse.ts';
import { answerText } from '../../../src/shared/blocks/answer-text.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { agent, harness } from '../chat/harness.ts';

const LONG = 'Voller Zugriff: ich öffne, installiere und richte auf diesem PC alles ein, was die Arbeit braucht';

function setup() {
  const h = harness();
  h.org.add(agent('ag_konrad', 'Konrad'));
  const chat = h.chats.create({ title: 'Start', agentIds: ['ag_konrad'], createdBy: HUMAN_ID });
  /** Konrad posts `body` (on `taskId`) and its ask blocks become to-dos. */
  const ask = (body: string, taskId?: string) => {
    const message = h.chats.send({ conversationId: chat.id, body, authorId: 'ag_konrad', authorKind: 'agent', ...(taskId ? { taskId } : {}) });
    const blocks = uiBlocksOf(body);
    const todos = h.tasks.ingestBlocks(message, blocks.map((item) => item.block), blocks.map((item) => item.index));
    return { message, todos };
  };
  const render = (afterSeq: number) => renderMessages({ services: h.services, agentId: 'ag_konrad', humanName: 'Alex', zone: 'UTC', now: h.clock.now() },
    h.chats.messages(chat.id, { afterSeq }), { images: false }).lines.join('\n');
  return { ...h, chat, ask, render };
}

test('a click on a choice: the person\'s line in full as a reply, no "Done:" line, one wake on the task, read like a typed line', () => {
  const h = setup();
  const work = h.tasks.create({ conversationId: h.chat.id, title: 'Set up this PC', assigneeKind: 'agent', assigneeId: 'ag_konrad', createdBy: HUMAN_ID });
  const block = JSON.stringify({ type: 'choice', important: true, id: 'zugang', question: 'Wie weit darf ich auf diesem PC gehen?', options: [LONG, 'Nur lesen'] });
  const { message, todos: [todo] } = h.ask(`Hallo, eine Frage:\n\`\`\`ui\n${block}\n\`\`\``, work.id);
  assert.equal(todo.parentId, work.id, 'the to-do is a step of the open task');
  h.db.run('DELETE FROM wakes');

  h.tasks.answer({ messageId: message.id, blockIndex: 0, answer: { choice: LONG }, by: HUMAN_ID });
  const after = h.chats.messages(h.chat.id, { afterSeq: message.seq });
  assert.deepEqual(after.map((item) => [item.kind, item.authorId, item.body, item.replyTo]), [['answer', HUMAN_ID, LONG, message.id]], 'one line, nothing beside it');
  assert.equal(after[0].meta.answer?.summary, LONG, 'the block\'s receipt has the text too, uncut');
  assert.equal(h.tasks.get(todo.id)?.status, 'done', 'the to-do behind the ask completes quietly');

  const wakes = h.wakeRows().filter((row) => row.agent_id === 'ag_konrad');
  assert.deepEqual(wakes.map((row) => [row.reason, row.conversation_id, row.task_id, row.note]), [['message', h.chat.id, work.id, null]], 'once, as for a typed line');

  const seen = h.render(message.seq);
  // Review fix: the line names the ask it answers (two asks in one message stay apart).
  assert.match(seen, /^\[[^\]]+\] Alex: \(answer to my ask "Wie weit darf ich auf diesem PC gehen\?"\)\nVoller Zugriff: ich öffne, installiere und richte auf diesem PC alles ein, was die Arbeit braucht$/);
  assert.doesNotMatch(seen, /ui-answer|Chose|\[task |Done:/);
});

test('review fixes: two asks in one message are told apart; a typed secret never shows; a person who left the chat still reaches the agent', () => {
  const h = setup();
  const one = JSON.stringify({ type: 'choice', important: true, id: 'zugang', question: 'Wie weit darf ich gehen?', options: ['Ganz', 'Wenig'] });
  const two = JSON.stringify({ type: 'choice', important: true, id: 'zuerst', question: 'Was zuerst?', options: ['Buch', 'Website'] });
  const { message } = h.ask(`Zwei Fragen:\n\`\`\`ui\n${one}\n\`\`\`\n\`\`\`ui\n${two}\n\`\`\``);
  h.tasks.answer({ messageId: message.id, blockIndex: 1, answer: { choice: 'Buch' }, by: HUMAN_ID });
  const seen = h.render(message.seq);
  assert.match(seen, /\(answer to my ask "Was zuerst\?"\)\nBuch/, seen);
  assert.doesNotMatch(seen, /Wie weit darf ich gehen/, 'the other ask is not quoted');

  // An answer stored before B-076 (no question kept) finds its ask by its block key "<message id>:<index>".
  const older = h.chats.send({ conversationId: h.chat.id, body: 'Buch', kind: 'answer', authorId: HUMAN_ID, authorKind: 'human', replyTo: message.id, meta: { answer: { blockKey: `${message.id}:1`, summary: 'Chose: Buch' } } });
  assert.match(h.render(older.seq - 1), /\(answer to my ask "Was zuerst\?"\)\nBuch/);
  // An answer with no asking message (a to-do on a task) still names its ask.
  const loose = h.chats.send({ conversationId: h.chat.id, body: 'Approved', kind: 'answer', authorId: HUMAN_ID, authorKind: 'human', meta: { answer: { blockKey: 'task_x', summary: 'Approved', question: 'Domain kaufen?' } } });
  assert.match(h.render(loose.seq - 1), /\(answer to the ask "Domain kaufen\?"\)\nApproved/);

  const form = { type: 'form', fields: [{ name: 'key', label: 'API key', kind: 'secret' }] };
  assert.equal(answerText(form, { values: { key: 'sk-live-typed' } }), 'API key: saved', 'the optimistic receipt never prints a typed secret');

  const gone = h.ask(`Noch eine:\n\`\`\`ui\n${JSON.stringify({ type: 'choice', important: true, id: 'spaeter', question: 'Heute oder morgen?', options: ['Heute', 'Morgen'] })}\n\`\`\``);
  h.db.run('DELETE FROM wakes');
  const send = h.chats.send.bind(h.chats);
  h.chats.send = () => { throw new Error('not a member'); };
  try { h.tasks.answer({ messageId: gone.message.id, blockIndex: 0, answer: { choice: 'Morgen' }, by: HUMAN_ID }); } finally { h.chats.send = send; }
  const wakes = h.wakeRows().filter((row) => row.agent_id === 'ag_konrad');
  assert.equal(wakes.length, 1, 'woken once');
  assert.equal(wakes[0].reason, 'answer');
  assert.match(String(wakes[0].note), /Reply to my to-do "Heute oder morgen\?":\nMorgen/);
});

test('a block without a to-do ("todo": false) and a form read as the person\'s line too', () => {
  const h = setup();
  const inline = JSON.stringify({ type: 'choice', question: 'Welches Buch zuerst?', todo: false, options: [{ label: 'Buch „Vom Modell zum Produkt“', value: 'modell' }, { label: 'Kurs', value: 'kurs' }] });
  const form = JSON.stringify({ type: 'form', important: true, id: 'firma', fields: [{ name: 'name', label: 'Firmenname' }, { name: 'seats', label: 'Plätze', kind: 'number' }, { name: 'news', label: 'Newsletter', kind: 'toggle' }] });
  const { message, todos } = h.ask(`Zwei Dinge:\n\`\`\`ui\n${inline}\n\`\`\`\n\`\`\`ui\n${form}\n\`\`\``);
  assert.equal(todos.length, 1, 'only the form is a to-do');
  h.tasks.answer({ messageId: message.id, blockIndex: 0, answer: { choice: 'modell' }, by: HUMAN_ID });
  h.tasks.answer({ messageId: message.id, blockIndex: 1, answer: { values: { name: 'Teydra', seats: 3, news: true } }, by: HUMAN_ID });
  const lines = h.chats.messages(h.chat.id, { afterSeq: message.seq });
  assert.deepEqual(lines.map((item) => [item.kind, item.body]), [
    ['answer', 'Buch „Vom Modell zum Produkt“'],
    ['answer', 'Firmenname: Teydra\nPlätze: 3\nNewsletter: yes'],
  ]);
  assert.deepEqual(h.wakeRows().filter((row) => row.agent_id === 'ag_konrad' && row.reason !== 'task').map((row) => [row.reason, row.note]), [['message', null]], 'two lines of one chat: one wake');
});
