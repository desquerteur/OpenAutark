// SM9 – the feedback panel's mic button (ui/feedback/bridge.ts DictationButton, used by
// useDictation): a short tap starts and the next tap stops, holding longer than HOLD_MS records
// until release, Enter/Space toggle; a release or second tap while the microphone still opens
// drops that take; only the button's own take is cancelled; closing the panel never leaves the
// microphone on; errors show, a cancelled start and a take without words ('') do not. The engine is a
// fake here (the real one without the bridge: endpoint-dictation.test.ts).
// Owns: these assertions only. Never: a real microphone, bridge or runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DictationCancelled } from '../../../src/ui/lib/dictation.ts';
import { RpcError } from '../../../src/ui/lib/rpc.ts';
import { DictationButton, HOLD_MS } from '../../../src/ui/feedback/bridge.ts';
import type { ButtonDictation } from '../../../src/ui/feedback/bridge.ts';

const tick = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

/** A fake engine whose start may wait, and the button under test with its view log. */
function setup(options: { hold?: boolean; text?: string; startError?: Error; finishError?: Error } = {}) {
  const log: string[] = [];
  const view: string[] = [];
  const opening: Array<() => void> = [];
  let ended: ((error?: string) => void) | undefined;
  let clock = 0;
  const engine: ButtonDictation = {
    start: async (onEnded) => {
      log.push('start');
      ended = onEnded;
      if (options.hold) await new Promise<void>((resolve) => opening.push(resolve));
      if (options.startError) throw options.startError;
    },
    finish: async (language) => {
      log.push(`finish ${language ?? '-'}`);
      if (options.finishError) throw options.finishError;
      return options.text ?? ' Fix the grey button. ';
    },
    cancel: () => { log.push('cancel'); },
  };
  const button = new DictationButton(() => engine, {
    state: (state) => view.push(state),
    error: (message) => { if (message) view.push(`error: ${message}`); },
    text: (text) => view.push(`text: ${text}`),
    language: () => 'de',
  }, () => clock);
  return {
    button, log, view,
    at: (ms: number) => { clock = ms; },
    open: () => opening.shift()?.(),
    endFromElsewhere: (error?: string) => ended?.(error),
  };
}

test('a short tap starts, the next tap stops with the text', async () => {
  const s = setup();
  s.at(0); s.button.press();
  await tick();
  s.at(HOLD_MS); s.button.release(); // a tap (not longer than HOLD_MS): keeps listening
  await tick();
  assert.deepEqual(s.view, ['listening']);
  s.at(5000); s.button.press(); s.at(5080); s.button.release();
  await tick();
  assert.deepEqual(s.log, ['start', 'finish de']);
  assert.deepEqual(s.view, ['listening', 'transcribing', 'text: Fix the grey button.', 'idle']);
});

test('holding longer than HOLD_MS records until release; Enter/Space toggle, but not the click of a press', async () => {
  const s = setup();
  s.at(0); s.button.press();
  await tick();
  s.at(HOLD_MS + 1); s.button.release();
  s.button.activate(); // the click that follows the release belongs to the press
  await tick();
  assert.deepEqual(s.log, ['start', 'finish de']);
  s.at(5000); s.button.activate(); // Enter on the focused button
  await tick();
  s.button.activate();
  await tick();
  assert.deepEqual(s.log, ['start', 'finish de', 'start', 'finish de']);
  assert.equal(s.view.at(-1), 'idle');
});

test('a release or second tap while the microphone opens drops that take (it heard nothing)', async () => {
  const held = setup({ hold: true });
  held.at(0); held.button.press();
  held.at(900); held.button.release(); // released while the permission prompt or microphone was still opening
  held.open();
  await tick();
  assert.deepEqual(held.log, ['start', 'cancel']);
  assert.deepEqual(held.view, ['idle']);

  const twice = setup({ hold: true });
  twice.at(0); twice.button.press(); twice.at(50); twice.button.release();
  twice.at(200); twice.button.press(); twice.at(250); twice.button.release(); // double tap
  twice.open();
  await tick();
  assert.deepEqual(twice.log, ['start', 'cancel']);
  twice.at(1000); twice.button.press(); // the next tap starts a fresh take
  twice.open();
  await tick();
  assert.deepEqual(twice.log, ['start', 'cancel', 'start']);
  assert.equal(twice.view.at(-1), 'listening');
});

test('cancel discards only its own take; a take ended elsewhere is not cancelled again', async () => {
  const s = setup();
  s.button.press();
  await tick();
  s.button.cancel();
  assert.deepEqual(s.log, ['start', 'cancel']);
  assert.deepEqual(s.view, ['listening', 'idle']);

  s.at(1000); s.button.press();
  await tick();
  s.endFromElsewhere(); // the composer took the microphone
  s.button.cancel();
  assert.deepEqual(s.log, ['start', 'cancel', 'start'], 'nothing of someone else\'s is cancelled');
  assert.equal(s.view.at(-1), 'idle');

  s.at(2000); s.button.press();
  await tick();
  s.endFromElsewhere('The recognizer stopped.');
  assert.deepEqual(s.view.slice(-2), ['idle', 'error: The recognizer stopped.']);
});

test('closing the panel while it starts or listens leaves no microphone on and shows nothing', async () => {
  const starting = setup({ hold: true });
  starting.button.press();
  starting.button.dispose();
  starting.open();
  await tick();
  assert.deepEqual(starting.log, ['start', 'cancel']);
  assert.deepEqual(starting.view, []);

  const listening = setup();
  listening.button.press();
  await tick();
  listening.button.dispose();
  assert.deepEqual(listening.log, ['start', 'cancel']);
});

test('errors show; a start overtaken by a newer one and an empty transcript show nothing', async () => {
  const denied = setup({ startError: new Error('Permission denied') });
  denied.button.press();
  await tick();
  assert.deepEqual(denied.view, ['idle', 'error: Permission denied']);

  const overtaken = setup({ startError: new DictationCancelled() });
  overtaken.button.press();
  await tick();
  assert.deepEqual(overtaken.view, ['idle']);

  const failed = setup({ finishError: new Error('The transcription timed out.') });
  failed.button.activate();
  await tick();
  failed.button.activate();
  await tick();
  assert.deepEqual(failed.view, ['listening', 'transcribing', 'error: The transcription timed out.', 'idle']);

  const silent = setup({ text: '  ' });
  silent.button.activate();
  await tick();
  silent.button.activate();
  await tick();
  assert.deepEqual(silent.view, ['listening', 'transcribing', 'idle']);

  // A take without words comes back as '' (above); the runtime's "no usable text" refusal is left
  // for a broken answer and shows like any failure – no English message is matched any more.
  const broken = setup({ finishError: new RpcError({ code: 'unavailable', message: 'The transcription returned no usable text.' }) });
  broken.button.activate();
  await tick();
  broken.button.activate();
  await tick();
  assert.deepEqual(broken.view, ['listening', 'transcribing', 'error: The transcription returned no usable text.', 'idle']);
});

test('B-055: the header cell\'s talk (beginHold/endHold) ends on release however short, drops a take still opening, never restarts', async () => {
  const s = setup();
  s.button.beginHold();
  await tick();
  s.button.endHold(); // released right after the hold was recognized: still the end of the talk
  await tick();
  assert.deepEqual(s.log, ['start', 'finish de']);
  assert.deepEqual(s.view, ['listening', 'transcribing', 'text: Fix the grey button.', 'idle']);

  const opening = setup({ hold: true });
  opening.button.beginHold();
  opening.button.endHold(); // released while the microphone still opened: nothing was heard
  opening.open();
  await tick();
  assert.deepEqual(opening.log, ['start', 'cancel']);

  const failed = setup({ startError: new Error('No microphone') });
  failed.button.beginHold();
  await tick();
  failed.button.endHold(); // the start failed: the release starts nothing new
  await tick();
  assert.deepEqual(failed.log, ['start']);
  assert.deepEqual(failed.view, ['idle', 'error: No microphone']);
});
