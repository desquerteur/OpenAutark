// AF-006: the rows both personality forms share – Settings › Personality (the global values) and an agent's own
// personality on its page (every field may say "Like everyone (…)", which removes its own value) – plus the preset chips,
// a text area that saves when it loses focus, and the preview of what the agents read.
// Owns: these controls. Never: talks RPC or holds values (the page saves; settings.json or personality.json hold them).

import { useEffect, useState } from 'preact/hooks';
import { PERSONALITY_PRESETS, type Personality, type PersonalityField, type PersonalityPreset } from '../../shared/model/personality.ts';
import { Row, Segmented, Select } from './controls.tsx';
import { ADDRESS_CHOICES, EMOJI_CHOICES, FIELD_LABELS, LENGTH_CHOICES, TONE_CHOICES, languageChoices, valueLabel, type Choice } from './personality-text.ts';

type ChoiceField = Exclude<PersonalityField, 'instructions'>;
const HINTS: Readonly<Record<ChoiceField, string>> = {
  tone: 'How the answers sound',
  address: 'du or Sie (tu or vous …) when they write to you',
  language: 'Auto: the language you write in',
  emoji: 'Emoji in the answers',
  length: 'How long a usual answer is',
};

function choicesOf(field: ChoiceField, current: string): ReadonlyArray<Choice<string>> {
  if (field === 'tone') return TONE_CHOICES;
  if (field === 'address') return ADDRESS_CHOICES;
  if (field === 'emoji') return EMOJI_CHOICES;
  if (field === 'length') return LENGTH_CHOICES;
  return languageChoices(current);
}

/**
 * The five choice rows. `global` given: an agent's form – each field starts with "Like everyone (<global value>)"
 * (value '', its own value removed) and drops 'Auto'; `values` then holds only its own fields.
 */
export function PersonalityRows(props: { values: Partial<Personality>; global?: Personality; disabled?: boolean; onChange: (field: ChoiceField, value: string) => void }) {
  const { global } = props;
  const fields: ChoiceField[] = ['tone', 'address', 'language', 'emoji', 'length'];
  return (
    <>
      {fields.map((field) => {
        const value = props.values[field] ?? '';
        const label = FIELD_LABELS[field];
        if (!global) {
          const choices = choicesOf(field, value);
          const segmented = field === 'address' || field === 'emoji' || field === 'length';
          return (
            <Row key={field} label={label} hint={HINTS[field]}>
              {segmented && !props.disabled
                ? <Segmented label={label} value={value || 'auto'} options={choices.map(({ value: item, label: text }) => ({ value: item, label: text }))} onChange={(next) => props.onChange(field, next)} />
                : <Select label={label} value={value} options={[...choices]} disabled={props.disabled} onChange={(next) => props.onChange(field, next)} />}
            </Row>
          );
        }
        const like = { value: '', label: `Like everyone (${valueLabel(field, global[field] as never)})` };
        const own = choicesOf(field, value).filter((choice) => choice.value !== 'auto' && choice.value !== '');
        return (
          <Row key={field} label={label} hint={value ? 'Set for this agent' : 'From Settings › Personality'}>
            <Select label={label} value={value} options={[like, ...own]} disabled={props.disabled} onChange={(next) => props.onChange(field, next)} />
          </Row>
        );
      })}
    </>
  );
}

/** The presets as chips; `selected`: the one whose style the values have. */
export function PresetChips(props: { selected?: string; disabled?: boolean; onPick: (preset: PersonalityPreset) => void }) {
  return (
    <div class="personality-presets" role="group" aria-label="Presets">
      {PERSONALITY_PRESETS.map((preset) => (
        <button key={preset.id} type="button" class={`chip personality-preset${preset.id === props.selected ? ' selected' : ''}`} aria-pressed={preset.id === props.selected}
          title={preset.description} disabled={props.disabled} onClick={() => props.onPick(preset)}>
          {preset.label}
        </button>
      ))}
    </div>
  );
}

/** A text area that saves on blur (and on Ctrl+Enter); the counter shows the room left. */
export function NoteField(props: { value: string; max: number; label: string; placeholder?: string; rows?: number; disabled?: boolean; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => { if (draft !== props.value) props.onCommit(draft); };
  return (
    <div class="personality-note">
      <textarea class="set-textarea" aria-label={props.label} placeholder={props.placeholder} rows={props.rows ?? 4} maxLength={props.max}
        disabled={props.disabled} value={draft}
        onInput={(event) => setDraft((event.currentTarget as HTMLTextAreaElement).value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) (event.currentTarget as HTMLTextAreaElement).blur(); }} />
      <small class="personality-count">{draft.length} / {props.max}</small>
    </div>
  );
}

/** "What the agents read": the prompt section as it goes out ('' = nothing set). */
export function PromptPreview(props: { text: string; empty: string }) {
  return (
    <details class="personality-preview">
      <summary>What the agents read</summary>
      {props.text ? <pre class="personality-preview-text">{props.text}</pre> : <p class="personality-preview-empty">{props.empty}</p>}
    </details>
  );
}
