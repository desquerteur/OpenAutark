// The subconscious's voice.words (subconscious/tools.ts): an after-turn run whose exchange names a product adds it to the
// learned words (settings.json voice.vocabulary) through a real SettingsStore, and nothing else there (in memory, and in the
// file: one changed line; a voice section not applied stays as written); the list never reaches the brain; a redacted word
// is not stored; a control character is a space; an add that changes nothing writes nothing; a failing write answers as
// text; the system prompt is the same with 0 and 1,000 learned words.
// Owns: these assertions only. Never: real models, network or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RESOURCES, fixture } from '../context/fixture.ts';
import { clock, recordingBus, tempDir } from '../store/helpers.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { ROOT_SETTINGS } from '../../../src/runtime/root/layout.ts';
import { RootWatcher } from '../../../src/runtime/root/watcher.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { runFlow } from '../../../src/runtime/subconscious/flow.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import type { Settings } from '../../../src/shared/model/system.ts';

type Call = Parameters<StructuredRunner>[0];

/** A brain answering step by step; after its script it says done. */
function brain(steps: Array<{ tool: string; args?: Record<string, unknown> }>) {
  const calls: Call[] = [];
  const runner: StructuredRunner = async (call) => {
    calls.push(call);
    const next = steps.shift() ?? { tool: 'done' };
    const structured = { tool: next.tool, args: JSON.stringify(next.args ?? {}) };
    return { text: JSON.stringify(structured), structured, by: 'fake' };
  };
  return { runner, calls };
}

/** The fixture with real prompts and a settings store holding these learned words (memory-only, or in `files`' settings.json). */
function world(vocabulary: string[] = ['Teydra'], files?: { dataDir: string; root: RootWatcher }) {
  const f = fixture();
  f.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
  const recorded = recordingBus();
  const settings = new SettingsStore({ bus: recorded.bus, clock: clock(), env: { locale: 'en-US', timezone: 'UTC' }, ...(files ?? {}) });
  if (vocabulary.length) settings.update({ voice: { vocabulary } });
  f.services.settings = settings;
  recorded.events.length = 0;
  /** An after-turn run whose exchange names Kling Studio, with a brain that calls `voice.words` with these words. */
  const run = async (words: unknown) => {
    const decision = brain([{ tool: 'voice.words', args: { words } }]);
    const result = await runFlow(f.services, { decision: decision.runner }, { kind: 'after-turn', agent: f.vid, thread: 't', context: 'The person: Wir schneiden ab jetzt mit Kling Studio.' });
    return { result, calls: decision.calls };
  };
  return { f, settings, run, updated: () => recorded.of('settings.updated').length };
}

/** The settings without the learned words. */
function rest(settings: Settings): unknown {
  const copy = structuredClone(settings);
  return { ...copy, voice: { ...copy.voice, vocabulary: undefined } };
}

test('a name of the exchange becomes the newest learned word; the brain gets the outcome, never the list', async () => {
  const w = world();
  const { result, calls } = await w.run(['Kling Studio']);
  assert.deepEqual(w.settings.get().voice.vocabulary, ['Teydra', 'Kling Studio']);
  assert.equal(w.updated(), 1, 'one write through the settings store');
  assert.equal(result.end, 'done');
  assert.ok(calls[1].prompt.includes('learned: Kling Studio'), calls[1].prompt);
  for (const call of calls) assert.ok(!call.prompt.includes('Teydra') && !call.system.includes('Teydra'), 'the list never reaches the brain');
});

test('everything in the settings but voice.vocabulary is the same before and after', async () => {
  const w = world();
  const before = rest(w.settings.get());
  await w.run(['Kling Studio']);
  assert.deepEqual(rest(w.settings.get()), before);
});

test('a word that redaction changes is not stored', async () => {
  const w = world();
  const { calls } = await w.run(['hunter2', 'Kling Studio']); // the fixture's secrets.redact replaces hunter2
  assert.deepEqual(w.settings.get().voice.vocabulary, ['Teydra', 'Kling Studio']);
  assert.ok(calls[1].prompt.includes('learned: Kling Studio\n'), calls[1].prompt);
});

test('adding the word that is already the newest writes nothing', async () => {
  const w = world();
  const { calls } = await w.run(['Teydra']);
  assert.equal(w.updated(), 0, 'no settings.updated');
  assert.deepEqual(w.settings.get().voice.vocabulary, ['Teydra']);
  assert.ok(calls[1].prompt.includes('learned: Teydra'));
});

test('a control character is a space; a word too long to be sent is not reported as learned', async () => {
  const w = world();
  await w.run(['Kling Studio', 'Bad\u001bWord']);
  assert.deepEqual(w.settings.get().voice.vocabulary, ['Teydra', 'Kling Studio', 'Bad Word']);

  const long = 'L'.repeat(100); // settings.json keeps up to 120 characters, a recognizer gets up to 80
  const held = world([long]);
  const { calls } = await held.run([long]);
  assert.equal(held.updated(), 0);
  assert.ok(!calls[1].prompt.includes('learned:') && calls[1].prompt.includes('voice.words needs names or terms of up to 80 characters.'), calls[1].prompt);
});

test('in settings.json only the vocabulary line changes; a voice section not applied stays as written', async (t) => {
  const temp = tempDir('wf-voice-words-');
  const root = new RootWatcher({ root: temp.dir, clock: clock(), watch: false, debounceMs: 1, maxWaitMs: 5 });
  root.start();
  const w = world(['Teydra'], { dataDir: temp.dir, root });
  t.after(() => { w.settings.close(); root.stop(); temp.cleanup(); });
  const file = path.join(temp.dir, ROOT_SETTINGS);
  const before = readFileSync(file, 'utf8').split('\n');
  await w.run(['Kling Studio']);
  const after = readFileSync(file, 'utf8').split('\n');
  assert.equal(after.length, before.length);
  const changed = after.filter((line, i) => line !== before[i]);
  assert.equal(changed.length, 1, changed.join('\n'));
  assert.match(changed[0], /^\s*"vocabulary": \["Teydra", "Kling Studio"\],?$/);

  // The person adds a word and mistypes another key of the section: the section waits, as written, with its notice.
  writeFileSync(file, readFileSync(file, 'utf8').replace('"Kling Studio"]', '"Kling Studio", "Remotion"]').replace(/"realtime": "[a-z]+"/, '"realtime": "maybe"'), 'utf8');
  root.nudge(ROOT_SETTINGS);
  root.flush(ROOT_SETTINGS);
  assert.match(w.settings.notice() ?? '', /voice was not applied/);
  const waiting = readFileSync(file, 'utf8');
  const { calls } = await w.run(['Parakeet']);
  assert.ok(calls[1].prompt.includes("Not written: settings.json's voice section holds an edit that is not applied"), calls[1].prompt);
  assert.equal(readFileSync(file, 'utf8'), waiting, 'the person\'s edit stays as written');
  assert.ok(waiting.includes('"Remotion"') && waiting.includes('"realtime": "maybe"'));
  assert.match(w.settings.notice() ?? '', /voice was not applied/);
});

test('a failing write answers as text and the run goes on to its end', async () => {
  const w = world();
  w.settings.update = () => { throw new Error('disk full'); };
  const { result, calls } = await w.run(['Kling Studio']);
  assert.ok(calls[1].prompt.includes('voice.words failed: disk full'), calls[1].prompt);
  assert.equal(result.end, 'done');
});

test('the first request is the same size with 0 and 1,000 learned words', async () => {
  const sizes: Array<{ system: number; prompt: number }> = [];
  for (const count of [0, 1000]) {
    const w = world(Array.from({ length: count }, (_v, i) => `Wort${i}`));
    const { calls } = await w.run([]);
    sizes.push({ system: calls[0].system.length, prompt: calls[0].prompt.length });
  }
  assert.ok(sizes[0].system > 0);
  assert.deepEqual(sizes[1], sizes[0]);
});
