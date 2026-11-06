// Prompt fragment tests: generated from the catalog, tiered, small, deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockHelp, blockPrompt, helpTopics } from '../../../src/shared/blocks/prompt.ts';
import { CATALOG } from '../../../src/shared/blocks/catalog.ts';
import { parseDuration, toNumber } from '../../../src/shared/blocks/coerce.ts';

/** Rough token estimate (~4 chars per token for English prose + JSON-ish signatures). */
const tokens = (text: string): number => Math.ceil(text.length / 4);

test('full prompt lists every catalog signature and stays near 400 tokens', () => {
  const text = blockPrompt({ tier: 'full' });
  for (const spec of CATALOG) assert.equal(text.includes(spec.signature), !spec.legacy, `${spec.type}: taught unless legacy`);
  assert.match(text, /Buttons are answers I offer, not a permission I wait for/, 'B-078 D9: quick replies, in my voice');
  assert.match(text, /"important":true puts the question above the person's input field/);
  assert.ok(tokens(text) < 600, `too long: ~${tokens(text)} tokens`);
  assert.match(text, /```app/);
  assert.match(text, /their click reaches me later as their line with what they picked;/, 'B-076: a click is the person\'s line');
  assert.doesNotMatch(text, /ui-answer|Never |you cannot/);
});

test('lite prompt only has lite blocks and no app', () => {
  const text = blockPrompt({ tier: 'lite' });
  for (const spec of CATALOG) {
    assert.equal(text.includes(spec.signature), spec.tier === 'lite' && !spec.legacy, spec.type);
  }
  assert.doesNotMatch(text, /```app/);
  assert.ok(tokens(text) < tokens(blockPrompt({ tier: 'full' })));
});

test('prompt is deterministic and names the help tool only when the agent has it', () => {
  assert.equal(blockPrompt(), blockPrompt());
  assert.doesNotMatch(blockPrompt(), /help/i);
  const full = blockPrompt({ helpTool: 'ui__help' });
  assert.match(full, /\nDetails: call ui__help with topic "app", "blocks" or a block type\.$/);
  assert.equal(full, blockPrompt({ helpTool: 'ui__help' }));
  // Lite agents are not taught ```app, so the help line does not offer it either.
  const lite = blockPrompt({ tier: 'lite', helpTool: 'ui__help' });
  assert.match(lite, /\nDetails: call ui__help with topic "blocks" or a block type\.$/);
  assert.doesNotMatch(lite, /"app"|mini-app/);
  assert.ok(tokens(full) < 600, `too long: ~${tokens(full)} tokens`);
});

test('blockHelp documents props, answers and examples', () => {
  const help = blockHelp('record');
  assert.match(help, /mode: audio\|video\|screen/);
  assert.match(help, /What reaches me when they click or send: their line "Recorded m:ss" with the recording attached, as a reply to my message\./);
  assert.match(help, /their line reads "I can't do this: <reason>" and I find a way without them/);
  assert.match(blockHelp('choice'), /their line with the picked option's text in full/);
  assert.doesNotMatch(`${help}\n${blockHelp('app')}`, /ui-answer/);
  assert.match(help, /```ui/);
  assert.match(blockHelp('app'), /wf\.complete/);
  assert.match(blockHelp('nope'), /Unknown topic/);
});

test('blockHelp: the mini-app guide, chart props, the topic index and unknown topics', () => {
  const app = blockHelp(' App ');
  for (const needle of ['--wf-bg', '--wf-accent', 'one column', 'no inner scrolling', 'wf.state.set', 'permissions=', 'todo=true', 'reason=', 'top-right corner']) {
    assert.ok(app.includes(needle), `app guide misses ${needle}`);
  }
  const chart = blockHelp('chart');
  assert.match(chart, /^## chart \(display\)/);
  assert.match(chart, /- kind: bar\|line\|area\|donut\|scatter/);
  assert.match(chart, /Example:\n```ui\n\{"type":"chart"/);
  const index = blockHelp('blocks');
  for (const spec of CATALOG) assert.equal(index.includes(`- ${spec.type} – ${spec.doc}`), !spec.legacy, `index and ${spec.type}`);
  assert.match(blockHelp('approve'), /I ask a yes\/no with a choice block/, 'the legacy card still explains itself');
  assert.match(index, /^- app – /m);
  assert.deepEqual(helpTopics().slice(0, 3), ['blocks', 'app', 'mermaid']);
  const unknown = blockHelp(`  ${'x'.repeat(80)}  `);
  assert.match(unknown, /^Unknown topic "x{40}"\. Topics: blocks, app, mermaid, callout, /);
  for (const spec of CATALOG) assert.ok(unknown.includes(spec.type), `unknown-topic list misses ${spec.type}`);
});

test('parseDuration reads ISO, shorthand and words', () => {
  assert.equal(parseDuration('PT1H30M'), 5_400_000);
  assert.equal(parseDuration('P1D'), 86_400_000);
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('10 minutes'), 600_000);
  assert.equal(parseDuration('2 Stunden'), 7_200_000);
  assert.equal(parseDuration('1 hour and 5 min'), 3_900_000);
  assert.equal(parseDuration('1,5 h'), 5_400_000);
  assert.equal(parseDuration('300'), 300_000);
  assert.equal(parseDuration('PT'), undefined);
  assert.equal(parseDuration('later'), undefined);
  assert.equal(parseDuration('5 bananas'), undefined);
});

test('toNumber handles locales and suffixes', () => {
  assert.equal(toNumber('1,234.5'), 1234.5);
  assert.equal(toNumber('1.234,5'), 1234.5);
  assert.equal(toNumber('1.2k'), 1200);
  assert.equal(toNumber('€ 12'), 12);
  assert.equal(toNumber('abc'), undefined);
});
