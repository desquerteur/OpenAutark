// AF-006: the settings.json section `personality` – the global personality every agent reads each turn (Settings ›
// Personality). settings/schema.ts lists it among its sections, so the file's comment lines, settings.schema.json, the
// defaults and the known keys come from here; settings/validate.ts calls validatePersonality on the merged settings.
// Owns: this section's key definitions and its value check. Never: reads or writes settings.json (settings/service.ts).

import type { Settings } from '../../shared/model/system.ts';
import {
  DEFAULT_PERSONALITY, PERSONALITY_ADDRESSES, PERSONALITY_EMOJI, PERSONALITY_FIELDS, PERSONALITY_INSTRUCTIONS_MAX,
  PERSONALITY_LANGUAGE, PERSONALITY_LENGTHS, PERSONALITY_TONES, personalityProblem,
} from '../../shared/model/personality.ts';
import type { KeyDef, SectionDef } from '../settings/schema.ts';

const choice = (key: string, about: string, options: readonly string[]): KeyDef =>
  ({ key, about, type: 'string', options, default: DEFAULT_PERSONALITY[key as keyof typeof DEFAULT_PERSONALITY] });

export const PERSONALITY_SECTION: SectionDef = { key: 'personality', title: 'Personality – how the agents speak to you (an agent\'s own one: agents/<id>/personality.json)', keys: [
  choice('tone', 'The tone of the answers (auto = each agent\'s own way)', PERSONALITY_TONES),
  choice('address', 'How the agents address you: informal (du, tu) or formal (Sie, vous)', PERSONALITY_ADDRESSES),
  { key: 'language', about: 'The language the agents answer in ("" = the language you write in)', type: 'string', allowed: '"" or a language code such as "de" or "en"',
    pattern: PERSONALITY_LANGUAGE.source, default: '' },
  choice('emoji', 'Emoji in the answers: on, off, or auto', PERSONALITY_EMOJI),
  choice('length', 'How long the answers are: short, medium, detailed, or auto', PERSONALITY_LENGTHS),
  { key: 'instructions', about: 'How the AI should treat you, in your own words – every agent reads it each turn', type: 'string',
    allowed: `text up to ${PERSONALITY_INSTRUCTIONS_MAX} characters`, maxLength: PERSONALITY_INSTRUCTIONS_MAX, default: '' },
] };

/** Checks the merged section (absent: settings from before it existed – the defaults apply). */
export function validatePersonality(value: Settings['personality'], bad: (path: string, expected: string) => never): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad('personality', 'an object');
  for (const field of PERSONALITY_FIELDS) {
    if (value[field] === undefined) continue; // a missing key is its default
    const problem = personalityProblem(field, value[field]);
    if (problem) bad(`personality.${field}`, problem);
  }
}
