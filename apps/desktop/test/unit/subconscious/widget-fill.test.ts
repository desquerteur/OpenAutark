// Widget props from the person's typed text (F05, src/runtime/subconscious/widget-fill.ts,
// widget-text.ts, widget.ts): the deterministic extractors (options, first link → confirm.url /
// review.src, "Script:" and bullets, day and time, repeat, amount, form fields without a
// credential), set props stay; the optional model fill only for gaps, with a JSON schema from the
// catalog's PropSpec, validated, grounded in the text and merged (model-made form fields keep a
// fill kind: no secret, no select without options); an invalid answer keeps the
// deterministic block.
// Owns: these assertions only. Never: network, real models or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UiBlock } from '../../../src/shared/blocks/catalog.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import { SubconsciousImpl } from '../../../src/runtime/subconscious/service.ts';
import { WIDGET_DECISION_MS, chooseWidget } from '../../../src/runtime/subconscious/widget.ts';
import { dueFromText, fillFromText, fillSchema, fillWithModel, gapsOf, keywordWidget, textWidget } from '../../../src/runtime/subconscious/widget-fill.ts';
import { humanReasonFor } from '../../../src/runtime/tasks/widgets.ts';
import { fakeDecisions } from '../context/fixture.ts';

const NOW = new Date(2026, 9, 20, 9, 0).getTime(); // a Tuesday, 9:00 local time
const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** A runner that records its input and answers with `answer` (an Error rejects). */
function runner(answer: { text?: string; structured?: unknown } | Error) {
  const calls: Array<Parameters<StructuredRunner>[0]> = [];
  const run: StructuredRunner = async (input) => {
    calls.push(input);
    if (answer instanceof Error) throw answer;
    return { text: answer.text ?? '', structured: answer.structured, by: 'fake:cheap' };
  };
  return { run, calls };
}

test('the text gives the props: options, link, script, bullets, day and time, repeat, amount', () => {
  assert.deepEqual(textWidget('Pick the logo: blue, green or red', NOW), {
    type: 'choice', question: 'Pick the logo',
    options: [{ label: 'Blue', value: 'Blue' }, { label: 'Green', value: 'Green' }, { label: 'Red', value: 'Red' }],
  });
  assert.equal(fillFromText({ type: 'confirm', instructions: 'Log in' }, 'Log in at https://bank.example/login, then confirm.', NOW).url, 'https://bank.example/login');
  assert.equal(textWidget('Review the draft at https://docs.example/d/1.', NOW).src, 'https://docs.example/d/1', 'the full stop is no part of the link');
  const script = textWidget('Record the voice-over. Script: Hello and welcome to the course.', NOW);
  assert.deepEqual([script.type, script.mode, script.script], ['record', 'audio', 'Hello and welcome to the course.']);
  const bullets = textWidget('Record a short video\n- greet the team\n- show the new office', NOW);
  assert.deepEqual([bullets.mode, bullets.bullets], ['video', ['greet the team', 'show the new office']]);
  const weekly = textWidget('Remind me every Monday at 8:00 to water the plants', NOW);
  assert.deepEqual([weekly.type, weekly.at, weekly.repeat], ['timer', new Date(local(26, 8)).toISOString(), 'weekly']);
  assert.deepEqual(textWidget('Approve the invoice of 49,90 €', NOW).amount, { value: 49.9, currency: 'EUR' });
  assert.deepEqual(textWidget('Pack: passport, charger and tickets', NOW).items, [
    { text: 'passport', done: false }, { text: 'charger', done: false }, { text: 'tickets', done: false },
  ]);
});

test('form fields from a list – labels, kinds and names, never a credential', () => {
  const form = fillFromText({ type: 'form', fields: [{ name: 'text', label: 'Visa', kind: 'longtext' }] }, 'Fill in for the visa: full name, passport number, email and password', NOW);
  assert.deepEqual(form.fields, [
    { name: 'full-name', label: 'Full name', kind: 'text' },
    { name: 'passport-number', label: 'Passport number', kind: 'text' },
    { name: 'email', label: 'Email', kind: 'email' },
  ]);
});

test('set props stay; only placeholders are replaced', () => {
  const picked: UiBlock = { type: 'choice', question: 'Logo?', options: [{ label: 'Teal', value: 'Teal' }, { label: 'Sand', value: 'Sand' }] };
  assert.deepEqual(fillFromText(picked, 'Logo: blue, green or red', NOW).options, picked.options);
  const yesNo = fillFromText({ type: 'choice', question: 'Logo?', options: ['Yes', 'No'] }, 'Logo: blue, green or red', NOW);
  assert.deepEqual((yesNo.options as Array<{ label: string }>).map((option) => option.label), ['Blue', 'Green', 'Red']);
  assert.equal(fillFromText({ type: 'confirm', instructions: 'x', url: 'https://kept.example' }, 'see https://other.example', NOW).url, 'https://kept.example');
  assert.equal(fillFromText({ type: 'timer', label: 'Tea', duration: 'PT5M' }, 'Tea at 17:00', NOW).at, undefined, 'a duration is a time already');
});

test('keywordWidget: a choice when the text asks to pick among options it names; a reminder stays a timer', () => {
  assert.equal(keywordWidget('Wähle das Logo: blau oder grün', NOW).type, 'choice');
  assert.equal(keywordWidget('The red one or the blue one?', NOW).type, 'choice');
  assert.equal(keywordWidget('Remind me at 17:00: milk, eggs or bread', NOW).type, 'timer');
  assert.equal(keywordWidget('Sign the delivery note', NOW).type, 'confirm');
});

test('dueFromText: the day the text names, at its clock time or the end of that day; never in the past', () => {
  assert.equal(dueFromText('Submit the tax form by Friday', NOW), local(23, 23, 59));
  assert.equal(dueFromText('Dentist tomorrow at 10:30', NOW), local(21, 10, 30));
  assert.equal(dueFromText('Call the bank at 17:00', NOW), local(20, 17), 'a clock time alone: today');
  assert.equal(dueFromText('Call the bank at 8:00', NOW), local(21, 8), 'already past: tomorrow');
  assert.equal(dueFromText('Call the plumber', NOW), undefined);
  assert.equal(dueFromText('Pay the bill on 1.1.2020', NOW), undefined);
});

test('the model fills only gaps, with a schema from the catalog, validated, grounded and merged', async () => {
  const text = 'Tell the bank your new address and phone';
  const form: UiBlock = { type: 'form', fields: [{ name: 'text', label: text, kind: 'longtext' }] };
  assert.deepEqual(gapsOf(form, text), ['fields']);
  const fake = runner({ structured: { fields: [
    { label: 'New address', kind: 'longtext' }, { label: 'Phone', kind: 'text' },
    { label: 'Bank PIN', kind: 'text' }, { label: 'Favourite colour', kind: 'text' }, // a credential, and nothing the text says
  ] } });
  const filled = await fillWithModel(fake.run, form, text, { now: NOW, redact: (value) => value.replace('bank', '[bank]') });
  assert.deepEqual(filled.fields, [
    { name: 'new-address', label: 'New address', kind: 'longtext' },
    { name: 'phone', label: 'Phone', kind: 'text' },
  ]);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].purpose, 'widget-fill');
  assert.ok(fake.calls[0].prompt.includes('Tell the [bank] your new address'), 'the text goes out redacted');
  const schema = fake.calls[0].schema as { required: string[]; additionalProperties: boolean; properties: Record<string, { type: string[] }> };
  assert.deepEqual([schema.required, schema.additionalProperties, schema.properties.fields.type], [['fields'], false, ['array', 'null']]);

  const timer = await fillWithModel(runner({ structured: { at: '2026-10-20T19:00', repeat: null } }).run, { type: 'timer', label: 'Plumber' }, 'Remind me in the evening to call the plumber', { now: NOW });
  assert.equal(timer.at, new Date(local(20, 19)).toISOString());
  assert.equal(timer.repeat, undefined, 'null = the text does not say');
});

test('model-made form fields keep a fill kind: secret kinds are dropped, a select without options becomes text, extras fall away', async () => {
  const text = 'Tell the bank your new address, phone, account number, mobile token and the branch';
  const form: UiBlock = { type: 'form', fields: [{ name: 'text', label: text, kind: 'longtext' }] };
  // Free JSON (not every engine enforces the schema): kinds and props the schema does not allow.
  const fake = runner({ text: JSON.stringify({ fields: [
    { label: 'New address', kind: 'longtext', value: 'Main St 1', required: true },
    { label: 'Phone', kind: 'select' }, { label: 'Branch', kind: 'dropdown', options: ['North', 'South'] },
    { label: 'Account number', kind: 'password' }, { label: 'Mobile', kind: 'secret' }, { label: 'Phone', kind: 'token' },
  ] }) });
  const filled = await fillWithModel(fake.run, form, text, { now: NOW });
  assert.deepEqual(filled.fields, [
    { name: 'new-address', label: 'New address', kind: 'longtext' },
    { name: 'phone', label: 'Phone', kind: 'text' },
    { name: 'branch', label: 'Branch', kind: 'text' },
  ]);
  assert.equal(humanReasonFor(filled), 'taste', 'no secret field, so no credential to-do');
});

test('the schema follows the PropSpec: enums keep their values, lists are string arrays, every prop is nullable', () => {
  const choice = fillSchema('choice', ['options', 'multi']) as { properties: Record<string, Record<string, unknown>> };
  assert.deepEqual(choice.properties.options, { type: ['array', 'null'], items: { type: 'string' } });
  assert.deepEqual(choice.properties.multi, { type: ['boolean', 'null'] });
  const timer = fillSchema('timer', ['repeat']) as { properties: Record<string, Record<string, unknown>> };
  assert.deepEqual(timer.properties.repeat, { type: ['string', 'null'], enum: ['daily', 'weekdays', 'weekly', null] });
});

test('an invalid, invented or failed model answer keeps the deterministic block; no gaps → no call', async () => {
  const text = 'Pick a venue for the party';
  const choice: UiBlock = { type: 'choice', question: text, options: ['Yes', 'No'] };
  for (const answer of [{ text: 'Sorry, I cannot help.' }, { structured: { options: 'the park' } }, { structured: { options: ['Moon base', 'Mars'] } }, new Error('engine down')]) {
    assert.deepEqual(await fillWithModel(runner(answer).run, choice, text, { now: NOW }).catch(() => choice), choice, JSON.stringify(answer));
  }
  const none = runner({ structured: {} });
  const confirm: UiBlock = { type: 'confirm', instructions: 'Sign the delivery note' };
  assert.deepEqual(await fillWithModel(none.run, confirm, 'Sign the delivery note', { now: NOW }), confirm);
  assert.equal(none.calls.length, 0, 'nothing to fill, no model call');
});

/** SubconsciousImpl over minimal services and one injected runner. */
function subconscious(run: StructuredRunner) {
  const services = {
    clock: { now: () => NOW }, log: quiet, secrets: { redact: (value: string) => value },
    settings: { get: () => ({}) }, catalog: { list: () => [] },
  } as unknown as RuntimeServices;
  return new SubconsciousImpl({ services: () => services, runner: run });
}

test("fillWidget: the text's props first, then the model; a failing model keeps the text's props", async () => {
  const text = 'Pick a venue for the party – maybe the park, maybe our home';
  const choice: UiBlock = { type: 'choice', question: 'Pick a venue', options: ['Yes', 'No'] };
  const venues = { structured: { options: ['The park', 'Our home'], multi: null } };
  const auto = runner(venues);
  const filled = await subconscious(auto.run).fillWidget(choice, text);
  assert.deepEqual((filled.options as Array<{ label: string }>).map((option) => option.label), ['The park', 'Our home']);
  assert.equal(auto.calls.length, 1);
  const broken = await subconscious(runner(new Error('engine down')).run).fillWidget({ type: 'confirm', instructions: 'x' }, 'Log in at https://bank.example then confirm');
  assert.equal(broken.url, 'https://bank.example');
});

test('chooseWidget: the decision runs with timeoutMs and the chosen type is filled from the text', async () => {
  const pick = fakeDecisions((request) => ({ choice: request.options!.find((option) => option.startsWith('choice:')) }));
  const block = await chooseWidget({ clock: { now: () => NOW }, log: quiet, decisions: pick.service } as never, 'Logo colours\n- blue\n- green');
  assert.equal(pick.calls[0].timeoutMs, WIDGET_DECISION_MS);
  assert.deepEqual([block.type, (block.options as Array<{ label: string }>).map((option) => option.label)], ['choice', ['Blue', 'Green']]);
});
