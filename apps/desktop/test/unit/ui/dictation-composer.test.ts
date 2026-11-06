// D13 – the composers' dictation controls, read from their source (no DOM here): the Plus button is
// never swapped for a one-click discard while dictating (regression: the X in Plus's slot threw the
// take away) – Discard is a Plus menu entry –, the mic keeps the field's focus and hands its caret
// to startDictation, shows the starting state in its own slot, the waveform sits in the spacer, and
// the worklet that feeds it is bundled next to index.html.
// Owns: these assertions only. Never: renders components.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');

test('Plus stays Plus while dictating in both composers; discarding is a Plus menu entry', () => {
  for (const file of ['src/ui/chat/Composer.tsx', 'src/ui/tasks/TaskComposer.tsx']) {
    const source = read(file);
    assert.doesNotMatch(source, /Cancel dictation|CancelDictationButton|composer-plus cancel/, `${file}: no X in Plus's slot`);
    assert.doesNotMatch(source, /isDictating\s*\?\s*<(?:CancelDictation|IconButton icon="x")/, file);
    assert.match(source, /<MicButton draftKey=\{[^}]+\} field=\{fieldRef\}/, `${file}: the shared mic button`);
    assert.match(source, /<div class="composer-spacer"><DictationWave state=\{waveState\([^)]+\)\} \/><\/div>/, `${file}: the waveform in the spacer`);
  }
  assert.match(read('src/ui/chat/Composer.tsx'), /discardDictation: isDictating \? \(\) => void cancelDictation\(\) : undefined/);
  assert.match(read('src/ui/tasks/TaskComposer.tsx'), /discard=\{isDictating \? \(\) => void cancelDictation\(\) : undefined\}/);
  assert.match(read('src/ui/chat/composer/PlusMenu.tsx'), /label: 'Discard dictation'/);
});

test('the mic keeps the field focused and passes its caret; starting and transcribing take the same slot', () => {
  const mic = read('src/ui/chat/composer/MicButton.tsx');
  assert.match(mic, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.match(mic, /startDictation\(key, targetOf\(props\.field\.current\)\)/);
  assert.match(mic, /dictationStarting\.value === key/);
  assert.match(mic, /disabled=\{waitsForSpeechModel\(note\)\}/,'while the speech model downloads the mic waits (its title says so)');
  assert.doesNotMatch(read('src/ui/chat/Composer.tsx'), /SpeechMarks|SpeechChips/, 'dictation inserts plain text: no unsure-word marks or chips');
});

test('the AudioWorklet tap is its own bundle next to index.html (the CSP allows it as self)', () => {
  const build = read('scripts/build.mjs');
  assert.match(build, /entryPoints: \['src\/ui\/lib\/pcm-worklet\.ts'\], outfile: 'app\/ui\/pcm-worklet\.js'/);
  assert.match(read('src/ui/lib/pcm-worklet.ts'), /export const PCM_TAP_MODULE = 'pcm-worklet\.js';/);
  assert.match(read('src/ui/lib/dictation.ts'), /\{ sampleRate: PCM_RATE, blockMs: BLOCK_MS \}/, 'dictation asks for 16 kHz');
});
