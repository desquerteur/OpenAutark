// AF-006: how the agents speak to the person – the global personality (settings.json section `personality`, Settings ›
// Personality) and an agent's own one that overrides it field by field (<data>/agents/<id>/personality.json, its page).
// 'auto' and '' mean "no wish": the agent keeps its own way there. The ready-made presets fill the same fields.
// Owns: the fields, their options, the limits, the merge (agent over global) and the presets. Never: reads or writes
// files, renders prompt text (runtime/personality/prompt.ts) or UI labels (ui/settings/personality-text.ts).

export const PERSONALITY_TONES = ['auto', 'factual', 'casual', 'friendly', 'formal', 'direct', 'playful'] as const;
export const PERSONALITY_ADDRESSES = ['auto', 'informal', 'formal'] as const;
export const PERSONALITY_EMOJI = ['auto', 'on', 'off'] as const;
export const PERSONALITY_LENGTHS = ['auto', 'short', 'medium', 'detailed'] as const;

export type PersonalityTone = (typeof PERSONALITY_TONES)[number];
export type PersonalityAddress = (typeof PERSONALITY_ADDRESSES)[number];
export type PersonalityEmoji = (typeof PERSONALITY_EMOJI)[number];
export type PersonalityLength = (typeof PERSONALITY_LENGTHS)[number];

/** The free text "How the AI should treat me" (like custom instructions elsewhere). */
export const PERSONALITY_INSTRUCTIONS_MAX = 1500;
/** '' = the language the person writes in; else a language code ("de", "en", "pt-BR"). */
export const PERSONALITY_LANGUAGE = /^(?:|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/;

export interface Personality {
  tone: PersonalityTone;
  /** du/Sie, tu/vous …: the informal or the formal form of address. */
  address: PersonalityAddress;
  language: string;
  emoji: PersonalityEmoji;
  length: PersonalityLength;
  instructions: string;
}

export type PersonalityField = keyof Personality;
export const PERSONALITY_FIELDS: readonly PersonalityField[] = ['tone', 'address', 'language', 'emoji', 'length', 'instructions'];

/** An agent's own values: a missing field follows the global personality. */
export type AgentPersonality = Partial<Personality>;

export const DEFAULT_PERSONALITY: Readonly<Personality> = { tone: 'auto', address: 'auto', language: '', emoji: 'auto', length: 'auto', instructions: '' };

const CHOICES: Readonly<Record<Exclude<PersonalityField, 'language' | 'instructions'>, readonly string[]>> = {
  tone: PERSONALITY_TONES, address: PERSONALITY_ADDRESSES, emoji: PERSONALITY_EMOJI, length: PERSONALITY_LENGTHS,
};

/** The fixed choices of a field ([] for the two text fields). */
export function choicesOf(field: PersonalityField): readonly string[] {
  return field === 'language' || field === 'instructions' ? [] : CHOICES[field];
}

/** Why `value` is no valid value of `field` (undefined: it is valid). */
export function personalityProblem(field: PersonalityField, value: unknown): string | undefined {
  if (typeof value !== 'string') return 'a text';
  if (field === 'language') return PERSONALITY_LANGUAGE.test(value) ? undefined : '"" (the language I write in) or a language code such as "de"';
  if (field === 'instructions') {
    return value.length <= PERSONALITY_INSTRUCTIONS_MAX && !/[\u0000-\u0008\u000b-\u001f]/.test(value) ? undefined : `text up to ${PERSONALITY_INSTRUCTIONS_MAX} characters`;
  }
  return CHOICES[field].includes(value) ? undefined : CHOICES[field].join(' | ');
}

/** The valid fields of `value` (anything else is dropped quietly – a hand-edited file never breaks a turn). */
export function cleanPersonality(value: unknown): AgentPersonality {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const field of PERSONALITY_FIELDS) {
    const item = (value as Record<string, unknown>)[field];
    if (item !== undefined && item !== null && personalityProblem(field, item) === undefined) out[field] = item as string;
  }
  return out as AgentPersonality;
}

/** True when the value says something ('auto' and '' say nothing). */
export function isSet(field: PersonalityField, value: string | undefined): boolean {
  if (value === undefined) return false;
  return field === 'language' || field === 'instructions' ? value.trim() !== '' : value !== 'auto';
}

/** The global personality with every field (missing or invalid ones at their default). */
export function globalPersonality(value: unknown): Personality {
  return { ...DEFAULT_PERSONALITY, ...cleanPersonality(value) };
}

/** What applies for one agent: per field its own value when it has one that says something, else the global one. */
export interface EffectivePersonality {
  values: Personality;
  /** The fields the agent's own value decides. */
  own: ReadonlySet<PersonalityField>;
  /** The global free text, also when the agent has its own (both apply; the agent's wins where they differ). */
  globalInstructions: string;
  ownInstructions: string;
}

export function effectivePersonality(global: unknown, own: AgentPersonality = {}): EffectivePersonality {
  const base = globalPersonality(global);
  const values = { ...base };
  const decided = new Set<PersonalityField>();
  for (const field of PERSONALITY_FIELDS) {
    const value = own[field];
    if (field === 'instructions' || !isSet(field, value)) continue;
    (values as Record<PersonalityField, string>)[field] = value!;
    decided.add(field);
  }
  const ownInstructions = own.instructions?.trim() ?? '';
  if (ownInstructions) decided.add('instructions');
  values.instructions = [base.instructions.trim(), ownInstructions].filter(Boolean).join('\n\n');
  return { values, own: decided, globalInstructions: base.instructions.trim(), ownInstructions };
}

/**
 * A ready-made personality to start from. It sets the style (tone, address, emoji, length) and may bring a text; it never
 * changes the language, and it fills the free text only while that is empty or still another preset's text – the
 * person's own words are never overwritten by a click.
 */
export interface PersonalityPreset {
  id: string;
  label: string;
  description: string;
  style: Pick<Personality, PresetField>;
  instructions: string;
}

export type PresetField = 'tone' | 'address' | 'emoji' | 'length';
export const PRESET_FIELDS: readonly PresetField[] = ['tone', 'address', 'emoji', 'length'];

const preset = (id: string, label: string, description: string, style: Partial<Pick<Personality, PresetField>>, instructions = ''): PersonalityPreset =>
  ({ id, label, description, style: { tone: 'auto', address: 'auto', emoji: 'auto', length: 'auto', ...style }, instructions });

export const PERSONALITY_PRESETS: readonly PersonalityPreset[] = [
  preset('standard', 'Standard', 'No wishes – every agent keeps its own way', {}),
  preset('brief', 'Factual and brief', 'The point first, no small talk, no emoji', { tone: 'factual', length: 'short', emoji: 'off' }),
  preset('casual', 'Casual and friendly', 'Relaxed, informal, an emoji where it fits', { tone: 'casual', address: 'informal', emoji: 'on', length: 'medium' }),
  preset('formal', 'Formal and thorough', 'Polite, formal address, complete answers', { tone: 'formal', address: 'formal', emoji: 'off', length: 'detailed' }),
  preset('coach', 'Patient coach', 'Warm, explains the why and the next step', { tone: 'friendly', length: 'detailed', emoji: 'off' },
    'Explain things step by step and say why, not only what. End with the one next step I can take myself.'),
  preset('sparring', 'Critical sparring partner', 'Direct, questions my assumptions', { tone: 'direct', length: 'medium', emoji: 'off' },
    'Challenge my assumptions and say plainly when you think I am wrong. Name the biggest risk of a plan before its upsides.'),
];

/** True when `text` is empty or exactly one preset's text (a preset may replace it). */
function presetOwnsText(text: string | undefined): boolean {
  const value = text?.trim() ?? '';
  return !value || PERSONALITY_PRESETS.some((item) => item.instructions && item.instructions === value);
}

/** The global personality after picking `preset` (language kept, the person's own text kept). */
export function applyPreset(current: Personality, preset: PersonalityPreset): Personality {
  return { ...current, ...preset.style, instructions: presetOwnsText(current.instructions) ? preset.instructions : current.instructions };
}

/** An agent's own values after picking `preset`: its style fields as the preset says ('auto' = like everyone), the rest kept. */
export function applyPresetToAgent(own: AgentPersonality, preset: PersonalityPreset): AgentPersonality {
  const out: AgentPersonality = { ...own };
  for (const field of PRESET_FIELDS) {
    if (preset.style[field] === 'auto') delete out[field];
    else (out as Record<PresetField, string>)[field] = preset.style[field];
  }
  if (presetOwnsText(own.instructions)) {
    if (preset.instructions) out.instructions = preset.instructions;
    else delete out.instructions;
  }
  return out;
}

/** The preset whose style `values` has (undefined: an own mix). */
export function matchingPreset(values: Pick<Personality, PresetField>): PersonalityPreset | undefined {
  return PERSONALITY_PRESETS.find((item) => PRESET_FIELDS.every((field) => item.style[field] === values[field]));
}
