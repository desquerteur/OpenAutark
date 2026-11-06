// The person's own line for a click or an entry on an ask block (shared/blocks/answer-text.ts, B-076 – owner
// 05.11.2026: "das ist einfach nur der Button-Klick"): a choice is the picked option's text in full (its label, no
// "Chose:", no cut), several joined, an "Other" text as typed; approve, confirm, review, timer, record, upload,
// checklist and a mini-app read as plain words; a form is one "Label: value" line per filled field (a secret as its
// handle, a stored file by its name); a note follows on its own line; a decline is "I can't do this: <reason>".
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerText, declineText, oneLine } from '../../../src/shared/blocks/answer-text.ts';

const LONG = 'Voller Zugriff: ich darf auf diesem PC alles öffnen, installieren und einrichten, was für die Arbeit nötig ist – ohne zu fragen';

test('a choice is the picked option\'s text in full – no "Chose:", no cut; labels, several picks and "Other"', () => {
  const block = { type: 'choice', question: 'Wie weit darf ich auf diesem PC gehen?', options: [LONG, 'Nur lesen', { label: 'Gar nicht', value: 'none' }] };
  assert.equal(answerText(block, { choice: LONG }), LONG);
  assert.ok(LONG.length > 80, 'longer than the old 80-character cut');
  assert.equal(answerText(block, { choice: 'none' }), 'Gar nicht', 'the label the person saw, not the value');
  assert.equal(answerText({ ...block, multi: true }, { choices: ['Nur lesen', 'none', 'Nur Mails'] }), 'Nur lesen, Gar nicht, Nur Mails', 'an Other text as typed');
  assert.equal(answerText(block, { choice: 'Buch „Vom Modell zum Produkt“ fertig bekommen' }), 'Buch „Vom Modell zum Produkt“ fertig bekommen');
});

test('approve, confirm, review, timer and record read as plain words, a note on its own line', () => {
  const approve = { type: 'approve', action: 'Publish the post' };
  assert.equal(answerText(approve, { approved: true }), 'Yes', 'B-078: the older card is a yes/no quick reply');
  assert.equal(answerText(approve, { approved: false, note: 'Not this week' }), 'No\nNot this week');
  // An older approve to-do whose fence now renders as a Yes/No choice answers with the picked option.
  assert.equal(answerText(approve, { choice: 'No' }), 'No');
  assert.equal(answerText(approve, { choices: ['No'] }), 'No');
  assert.equal(answerText(approve, { choice: 'Yes' }), 'Yes');
  assert.equal(answerText({ type: 'confirm', instructions: 'Log in', confirmLabel: 'Signed in' }, { done: true }), 'Signed in', 'the button the person clicked');
  assert.equal(answerText({ type: 'confirm', instructions: 'Plug it in' }, { done: true, note: 'took a while' }), 'Done\ntook a while');
  assert.equal(answerText({ type: 'review', src: 'a.png' }, { verdict: 'Needs changes', note: 'Brighter please' }), 'Needs changes\nBrighter please');
  assert.equal(answerText({ type: 'timer', label: 'Tea' }, { event: 'done' }), 'Done');
  assert.equal(answerText({ type: 'record', mode: 'audio' }, { file: 'a'.repeat(64), seconds: 63 }), 'Recorded 1:03');
});

test('uploads name their stored files; the UI\'s own receipt uses the names the widget sent', () => {
  const upload = { type: 'upload', label: 'Your ID' };
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const names = (id: string) => (id === a ? 'front.pdf' : undefined);
  assert.equal(answerText(upload, { files: [a, b, a], names: ['x.pdf', 'y.pdf', 'x.pdf'] }, names), 'Uploaded front.pdf', 'stored names only, once each');
  assert.equal(answerText(upload, { files: [a, b], names: ['front.pdf', 'back.png'] }), 'Uploaded front.pdf, back.png');
  assert.equal(answerText(upload, { files: ['C:/scans/front.pdf'] }, names), 'Uploaded front.pdf', 'a path by its last part');
  assert.equal(answerText(upload, { files: [b] }, names), 'Uploaded 1 file', 'an unknown id is no name');
});

test('a checklist says what was checked and what stays open', () => {
  const list = { type: 'checklist', items: ['Charge the camera', 'Clean the desk', 'Water'] };
  assert.equal(answerText(list, { checked: ['Charge the camera', 'Clean the desk'], open: ['Water'] }), 'Checked: Charge the camera, Clean the desk\nStill open: Water');
  assert.equal(answerText(list, { checked: [], open: ['Water'] }), 'Nothing checked\nStill open: Water');
});

test('a form is one "Label: value" line per filled field, in its order; a secret stays its handle, a file its name', () => {
  const photo = 'c'.repeat(64);
  const form = { type: 'form', fields: [
    { name: 'domain', label: 'Domain' }, { name: 'apiKey', label: 'API key', kind: 'secret' }, { name: 'empty', label: 'Empty' },
    { name: 'news', label: 'Newsletter', kind: 'toggle' }, { name: 'count', label: 'Seats', kind: 'number' }, { name: 'photo', label: 'Photo', kind: 'file' },
  ] };
  const values = { photo: [photo], count: 3, news: false, empty: '', apiKey: 'secret://sec_abc', domain: 'example.com', extra: 'kept' };
  assert.equal(answerText(form, { values }, (id) => (id === photo ? 'me.png' : undefined)), [
    'Domain: example.com', 'API key: secret://sec_abc', 'Newsletter: no', 'Seats: 3', 'Photo: me.png', 'extra: kept',
  ].join('\n'));
  assert.equal(answerText(form, { values: {} }), 'Sent');
  // Review fix: the UI's optimistic receipt holds the typed value – a secret field never shows it.
  const typed = answerText(form, { values: { apiKey: 'sk-live-very-secret-value', domain: 'example.com' } });
  assert.ok(!typed.includes('sk-live-very-secret-value'), typed);
  assert.match(typed, /API key: saved/);
});

test('a mini-app to-do: "Done in mini-app" with the data its app handed back, a stored take by its name', () => {
  const app = { type: 'app', messageId: 'msg_1', index: 0, permissions: [] };
  const take = 'd'.repeat(64);
  assert.equal(answerText(app, { take: { fileId: take, name: 'take.wav', mime: 'audio/wav' }, seconds: 12 }, (id) => (id === take ? 'take.wav' : undefined)), 'Done in mini-app\ntake: take.wav\nseconds: 12');
  assert.equal(answerText(app, null), 'Done in mini-app');
});

test('a decline is what the person said; oneLine joins the lines and cuts long ones', () => {
  assert.equal(declineText('No camera here'), "I can't do this: No camera here");
  assert.equal(declineText(), "I can't do this.");
  assert.equal(oneLine('Approved\nNot this week'), 'Approved · Not this week');
  assert.equal(oneLine('x'.repeat(400)).length, 300);
  assert.ok(oneLine('x'.repeat(400)).endsWith('…'));
});
