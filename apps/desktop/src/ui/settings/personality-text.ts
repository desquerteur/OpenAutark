// AF-006: the words of Settings › Personality and of an agent's own personality on its page – the option labels of each
// field (shared/model/personality.ts holds the values), the language choices and a value's label for "Like everyone (…)".
// Owns: these labels. Never: values, defaults or how the agents read them (runtime/personality/prompt.ts).

import type { Personality, PersonalityAddress, PersonalityEmoji, PersonalityField, PersonalityLength, PersonalityTone } from '../../shared/model/personality.ts';

export interface Choice<T extends string> { value: T; label: string; hint?: string }

export const TONE_CHOICES: ReadonlyArray<Choice<PersonalityTone>> = [
  { value: 'auto', label: 'Auto', hint: 'Each agent\'s own way' },
  { value: 'factual', label: 'Factual', hint: 'To the point, no small talk' },
  { value: 'casual', label: 'Casual', hint: 'Relaxed, like a colleague you know well' },
  { value: 'friendly', label: 'Friendly', hint: 'Warm and kind' },
  { value: 'formal', label: 'Formal', hint: 'Polite and proper' },
  { value: 'direct', label: 'Direct', hint: 'Candid, says plainly what it thinks' },
  { value: 'playful', label: 'Playful', hint: 'Light, with a little humour' },
];

export const ADDRESS_CHOICES: ReadonlyArray<Choice<PersonalityAddress>> = [
  { value: 'auto', label: 'Auto' },
  { value: 'informal', label: 'Informal (du)' },
  { value: 'formal', label: 'Formal (Sie)' },
];

export const EMOJI_CHOICES: ReadonlyArray<Choice<PersonalityEmoji>> = [
  { value: 'auto', label: 'Auto' },
  { value: 'on', label: 'Yes' },
  { value: 'off', label: 'No' },
];

export const LENGTH_CHOICES: ReadonlyArray<Choice<PersonalityLength>> = [
  { value: 'auto', label: 'Auto', hint: 'As the question needs' },
  { value: 'short', label: 'Short', hint: 'The point first, a few sentences' },
  { value: 'medium', label: 'Medium', hint: 'Complete, without padding' },
  { value: 'detailed', label: 'Detailed', hint: 'Thorough, with background and reasons' },
];

const LANGUAGE_CODES = ['de', 'en', 'fr', 'es', 'it', 'nl', 'pt', 'pl', 'tr', 'uk', 'ru', 'sv', 'da', 'cs', 'zh', 'ja'];

/** A language code's own name ("de" → "Deutsch"), the code itself when the browser does not know it. */
export function languageLabel(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : code;
  } catch {
    return code;
  }
}

/** '' (the language you write in) and the common languages; `current` stays a choice when it is another one. */
export function languageChoices(current = ''): Array<Choice<string>> {
  const codes = current && !LANGUAGE_CODES.includes(current) ? [...LANGUAGE_CODES, current] : LANGUAGE_CODES;
  return [{ value: '', label: 'Auto', hint: 'The language you write in' }, ...codes.map((code) => ({ value: code, label: languageLabel(code) }))];
}

export const FIELD_LABELS: Readonly<Record<PersonalityField, string>> = {
  tone: 'Tone', address: 'Form of address', language: 'Language', emoji: 'Emoji', length: 'Length of answers', instructions: 'How the AI should treat you',
};

/** The label of a field's value ("Casual", "Deutsch", "Auto"). */
export function valueLabel(field: Exclude<PersonalityField, 'instructions'>, value: Personality[typeof field]): string {
  if (field === 'language') return value ? languageLabel(value) : 'Auto';
  const choices: ReadonlyArray<Choice<string>> = field === 'tone' ? TONE_CHOICES : field === 'address' ? ADDRESS_CHOICES : field === 'emoji' ? EMOJI_CHOICES : LENGTH_CHOICES;
  return choices.find((choice) => choice.value === value)?.label ?? value;
}
