// Dictation into one of My day's fields (the input row, a calendar slot) through the app's one
// microphone path (chat/composer/voice.ts over lib/dictation.ts – the same path the chat composer and the
// Work composer use). Offered only where it gives text (lib/dictation.ts dictationNote is empty), and a take that comes back as a recording is dropped with a note (the field cannot attach
// it); the words are appended to the field.
// A field that goes away mid-dictation cancels it (the field's text goes with it).
// Owns: the hook. Never: picks the dictation path or touches the microphone itself.

import { useEffect } from 'preact/hooks';
import { dictationNote } from '../lib/dictation.ts';
import { cancelDictation, dictating, startDictation, stopDictation, transcribing } from '../chat/composer/voice.ts';

export interface FieldDictation {
  /** Dictation can give text here. */
  available: boolean;
  /** This field is dictating. */
  active: boolean;
  /** Its take is being transcribed. */
  transcribing: boolean;
  /** Starts, or stops and appends what was said. */
  toggle: () => Promise<void>;
  /** Stops and returns what was said ('' when nothing). */
  stop: () => Promise<string>;
  cancel: () => void;
}

export function useFieldDictation(key: string, append: (said: string) => void): FieldDictation {
  const active = dictating.value === key;
  useEffect(() => () => { if (dictating.peek() === key) void cancelDictation(); }, [key]);
  const stop = async (): Promise<string> => {
    if (dictating.peek() !== key) return '';
    return (await stopDictation({ attach: false })).text ?? ''; // a field cannot hold a recording
  };
  return {
    available: !dictationNote(),
    active,
    transcribing: transcribing.value.has(key),
    toggle: async () => {
      if (dictating.peek() === key) { const said = await stop(); if (said) append(said); return; }
      await startDictation(key);
    },
    stop,
    cancel: () => void cancelDictation(),
  };
}
