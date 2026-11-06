// D13: the composers' mic button (chat composer, task composer) in its one 36 px slot: Dictate →
// starting (a spinner from the tap until the microphone is open) → Stop → transcribing (spinner).
// It never takes the focus from the field (mousedown is prevented), so the take goes to the
// field's caret or selection, read at the click; a field that was not focused gets it appended.
// Its title says why this page gives no text right now (lib/dictation.ts dictationNote); while this PC's
// speech model still downloads ("Speech model downloading NN %") it stays disabled. useDictationField puts
// the caret after the inserted words and gives the waveform its state.
// Owns: the button and the caret hand-over. Never: dictation itself (voice.ts).

import type { RefObject } from 'preact';
import { useEffect } from 'preact/hooks';
import { dictationNote } from '../../lib/dictation.ts';
import { IconButton, Spinner } from '../../lib/ui.tsx';
import type { DictationTarget } from './dictation-insert.ts';
import type { WaveState } from './DictationWave.tsx';
import { dictating, dictationCaret, dictationStarting, startDictation, transcribing } from './voice.ts';

/** The field's caret/selection right now (`focused`: the take goes there, else it is appended). */
export function targetOf(field: HTMLTextAreaElement | null): DictationTarget | undefined {
  if (!field) return undefined;
  return { start: field.selectionStart, end: field.selectionEnd, focused: typeof document !== 'undefined' && document.activeElement === field };
}

/** The mic waits for this PC's speech model (its download or unpacking) – nothing could hear a take yet. */
export function waitsForSpeechModel(note: string | undefined): boolean {
  return note?.startsWith('Speech model') === true;
}

export function MicButton(props: { draftKey: string; field: RefObject<HTMLTextAreaElement>; onStop: () => void }) {
  const key = props.draftKey;
  if (transcribing.value.has(key)) {
    return <button type="button" class="icon-button" aria-label="Transcribing dictation" title="Transcribing dictation" disabled><Spinner size={16} label="Transcribing dictation" /></button>;
  }
  if (dictationStarting.value === key) {
    return <button type="button" class="icon-button dictation-starting" aria-label="Starting dictation" title="Starting dictation" disabled><Spinner size={16} label="Starting dictation" /></button>;
  }
  const active = dictating.value === key;
  const note = active ? undefined : dictationNote();
  return (
    <IconButton icon={active ? 'stop' : 'microphone'} label={active ? 'Stop dictation' : 'Dictate'} pressed={active}
      title={note ?? (active ? 'Stop dictation' : 'Dictate')} disabled={waitsForSpeechModel(note)}
      onMouseDown={(event) => event.preventDefault()} // the field keeps its focus and caret
      onClick={() => void (active ? props.onStop() : startDictation(key, targetOf(props.field.current)))} />
  );
}

/** The waveform's state for this draft. */
export function waveState(key: string): WaveState {
  if (dictating.value === key) return 'live';
  return dictationStarting.value === key ? 'starting' : 'idle';
}

/** After a take went into this draft: the caret after its words (when the field still has the focus). */
export function useDictationField(key: string, field: RefObject<HTMLTextAreaElement>, onCaret?: (caret: number) => void): void {
  const placed = dictationCaret.value;
  useEffect(() => {
    if (!placed || placed.conversationId !== key) return;
    const frame = requestAnimationFrame(() => {
      const area = field.current;
      if (!area || document.activeElement !== area) return;
      const caret = Math.min(placed.caret, area.value.length);
      area.setSelectionRange(caret, caret);
      onCaret?.(caret);
    });
    return () => cancelAnimationFrame(frame);
  }, [placed?.seq]);
}
