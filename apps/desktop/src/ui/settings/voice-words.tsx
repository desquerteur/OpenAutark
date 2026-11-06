// Settings › Models › Voice (B-078: was the Voice page): the reading voice (voice.ttsVoice, this device's voices for the profile language, voice-list.ts) and
// the learned words (voice.vocabulary; Edit opens
// the list in a dialog of fixed height: the field on top, the list filling the rest, Done – adding a word moves nothing).
// A word is added by the one rule the subconscious's voice.words follows too (shared/voice/vocabulary.ts withWords): a full list drops its oldest.
// Owns: these two rows and the dialog. Never: keeps a voice that is not offered here as if it were.

import { useEffect, useState } from 'preact/hooks';
import type { VoiceSettings } from '../../shared/model/system.ts';
import { withWords, WORD_CHARS } from '../../shared/voice/vocabulary.ts';
import { can } from '../lib/session.ts';
import { settings, updateSettings } from '../lib/store.ts';
import { Button, Dialog, DialogActions } from '../lib/ui.tsx';
import { act, CLEAR, Note, Row, Select, type Option } from './controls.tsx';
import { voiceChoice } from './voice-list.ts';

/** All of this device's voices, loaded when the browser has them. */
function useDeviceVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (typeof speechSynthesis === 'undefined') return;
    const load = () => setVoices(speechSynthesis.getVoices());
    load();
    speechSynthesis.addEventListener('voiceschanged', load);
    return () => speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);
  return voices;
}

const setVoice = (patch: Partial<VoiceSettings>) => void act(() => updateSettings({ voice: patch }), 'Could not save');

export function ReadingVoiceRow() {
  const voices = useDeviceVoices();
  const current = settings.value;
  const voice = current?.voice;
  if (!current || !voice) return null;
  const reading = voiceChoice(voices, current.profile.language, voice.ttsVoice);
  const options: Array<Option<string>> = [{ value: '', label: 'Default' }, ...reading.offered.map((entry) => ({ value: entry.name, label: entry.name }))];
  if (voice.ttsVoice && !options.some((option) => option.value === voice.ttsVoice)) options.push({ value: voice.ttsVoice, label: voice.ttsVoice });
  return (
    <Row label="Reading voice" reserve hint={reading.missing ? <Note>Not on this device – the default voice is used</Note>
      : reading.otherLanguage ? <Note>Not a voice for the profile language – replies are read with it anyway</Note> : 'Reads replies aloud in conversations'}>
      <Select label="Reading voice" value={voice.ttsVoice ?? ''} options={options} disabled={!can('settings.update')} onChange={(name) => setVoice({ ttsVoice: name || CLEAR })} />
    </Row>
  );
}

function WordList(props: { words: string[]; onChange: (words: string[]) => void; onDone: () => void }) {
  const [term, setTerm] = useState('');
  const add = () => {
    if (!term.trim()) return;
    props.onChange(withWords(props.words, [term]));
    setTerm('');
  };
  return (
    <>
      <p class="dialog-text voice-words-hint">Names and terms speech recognition should know</p>
      <form class="voice-word-add" onSubmit={(event) => { event.preventDefault(); add(); }}>
        <input class="set-input" aria-label="Term" placeholder="Term" maxLength={WORD_CHARS} value={term} onInput={(event) => setTerm((event.currentTarget as HTMLInputElement).value)} />
        <button type="submit" class="button secondary small" disabled={!term.trim()}>Add</button>
      </form>
      <ul class="voice-words" aria-label="Word list">
        {props.words.map((word) => (
          <li key={word} class="voice-word">
            <span class="voice-word-term">{word}</span>
            <button type="button" class="button ghost small danger" aria-label={`Remove ${word}`} onClick={() => props.onChange(props.words.filter((entry) => entry !== word))}>Remove</button>
          </li>
        ))}
        {!props.words.length && <li class="voice-words-empty">No words yet</li>}
      </ul>
      <DialogActions>
        <Button variant="primary" onClick={props.onDone}>Done</Button>
      </DialogActions>
    </>
  );
}

export function LearnedWordsRow() {
  const words = settings.value?.voice?.vocabulary ?? [];
  const [open, setOpen] = useState(false);
  const locked = !can('settings.update');
  return (
    <>
      <Row label={`Learned words (${words.length})`} reserve hint="Names and terms speech recognition should know">
        <button type="button" class="button secondary small" disabled={locked} aria-haspopup="dialog" onClick={() => setOpen(true)}>Edit</button>
      </Row>
      <Dialog open={open && !locked} onClose={() => setOpen(false)} title="Learned words" width={640} class="voice-words-dialog anchored">
        <WordList words={words} onChange={(vocabulary) => setVoice({ vocabulary })} onDone={() => setOpen(false)} />
      </Dialog>
    </>
  );
}
