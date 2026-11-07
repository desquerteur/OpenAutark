// AF-006: the volatile prompt section "## My personality" – the global personality (settings.json `personality`,
// Settings › Personality) with the agent's own values over it (personality/store.ts), read fresh for every turn
// (context/prompt-volatile.ts 'personality'), so a change applies at the next answer without a restart; a resumed native
// session gets it again only when it changed (agents/volatile-delta.ts). Nothing set (all 'auto', no text): no section,
// so the prompt stays as it was. In the agent's own voice like the other sections (B-075). The person's "About me"
// (profile.notes) stays in the stable "My environment" (context/environment.ts notesLine).
// Owns: the section's wording. Never: changes a value, or lets the personality bend facts or the rules.

import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import { effectivePersonality, type AgentPersonality, type Personality, type PersonalityField } from '../../shared/model/personality.ts';
import { languageName } from '../context/environment.ts';
import { PERSONALITY_FILE, readAgentPersonality } from './store.ts';

const TONE: Readonly<Record<Exclude<Personality['tone'], 'auto'>, string>> = {
  factual: 'factual and to the point – no small talk',
  casual: 'casual and relaxed, like a colleague they know well',
  friendly: 'warm and friendly',
  formal: 'formal and polite',
  direct: 'direct and candid – I say plainly what I think',
  playful: 'light and playful, with a little humour where it fits',
};

const LENGTH: Readonly<Record<Exclude<Personality['length'], 'auto'>, string>> = {
  short: 'short – the point first, a few sentences; more only when asked',
  medium: 'medium – complete, without padding',
  detailed: 'detailed – thorough, with background and reasons',
};

export interface PersonalityInput {
  /** The person's name ('' = none set). */
  name: string;
  agentId: string;
  /** settings.json `personality` (anything: invalid fields count as not set). */
  global: unknown;
  own?: AgentPersonality;
}

/** The section's text ('' when nothing is set). Pure – the tests and personality.preview use it directly. */
export function personalityText(input: PersonalityInput): string {
  const person = input.name.trim() || 'the person';
  const { values, own, globalInstructions, ownInstructions } = effectivePersonality(input.global, input.own);
  const mine = (field: PersonalityField) => (own.has(field) ? ' (set for me)' : '');
  const lines: string[] = [];
  if (values.tone !== 'auto') lines.push(`- Tone: ${TONE[values.tone]}${mine('tone')}.`);
  if (values.address === 'informal') lines.push(`- Address: I address ${person} informally (du in German, tu in French …)${mine('address')}.`);
  if (values.address === 'formal') lines.push(`- Address: I address ${person} formally (Sie in German, vous in French …)${mine('address')}.`);
  if (values.language.trim()) lines.push(`- Language: I answer in ${languageName(values.language)}, also when a message comes in another language${mine('language')}.`);
  if (values.emoji === 'on') lines.push(`- Emoji: now and then, where one fits${mine('emoji')}.`);
  if (values.emoji === 'off') lines.push(`- Emoji: none${mine('emoji')}.`);
  if (values.length !== 'auto') lines.push(`- Length: ${LENGTH[values.length]}${mine('length')}.`);
  if (globalInstructions) lines.push(`How ${person} wants me to treat them, in their words:`, globalInstructions);
  if (ownInstructions) lines.push(`Set for me alone (where it differs from the above, this wins):`, ownInstructions);
  if (!lines.length) return '';
  const where = `Settings › Personality; my own values in agents/${input.agentId}/${PERSONALITY_FILE} go first`;
  return [`## My personality (how ${person} wants me to write – ${where}; it shapes how I say things, never what is true or what I do)`, ...lines].join('\n');
}

/** The section for `agent` this turn: the settings and its own file as they are now. */
export function personalitySection(services: RuntimeServices, agent: Agent): string {
  let settings: ReturnType<RuntimeServices['settings']['get']> | undefined;
  try { settings = services.settings.get(); } catch { settings = undefined; }
  return personalityText({
    name: settings?.profile?.name ?? '',
    agentId: agent.id,
    global: settings?.personality,
    own: readAgentPersonality(services.paths?.data, agent.id),
  });
}
