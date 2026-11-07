// The setup assistant's pure rules (FirstRun.tsx and its cards, tested in test/unit/ui/first-run.test.ts): when the layer
// shows (settings.onboarding.step not 'done', on the owner's window, never in a hidden preview, on My day – 'home' and
// 'day' alike), the step order – AF-002: Profile (language, name, company), AI (a model that answers, or skipped on
// purpose), Connectors (optional) and Your first agent (the Manager, or a first hire) –, each step's one sentence on what
// it is for, whether any model can answer (the AI step's Continue, Home's "No AI" notice), the profile write and when
// "Connect to my other device" (ConnectCard.tsx) ends the layer.
// Owns: these pure checks. Never: reads signals, calls the runtime or renders.

import type { Account, AccountState, ModelInfo } from '../../shared/model/providers.ts';
import type { RemoteOutgoing } from '../../shared/model/remote.ts';
import type { OnboardingStep, Settings } from '../../shared/model/system.ts';
import { isChatModel } from '../lib/model-fit.ts';

/** The assistant's steps in order ('done' ends the layer). */
export const CARDS = ['profile', 'ai', 'connectors', 'agent'] as const satisfies readonly OnboardingStep[];
export type Card = (typeof CARDS)[number];
export const FIRST_STEP: Card = CARDS[0];
/** The layer's title: the computer's header row and the phone's top row. */
export const FIRST_RUN_TITLE = 'Set up';

/** Each step's heading and its one sentence: what it is for. */
export const STEP_INFO: Readonly<Record<Card, { title: string; purpose: string }>> = {
  profile: { title: 'About you', purpose: 'Your agents speak with you in this language and address you by your name.' },
  ai: { title: 'Connect an AI', purpose: 'Your agents think with this AI – connect a plan, an API key or a local server and test it.' },
  connectors: { title: 'Connect your tools', purpose: 'Optional: with GitHub, mail or an MCP server your agents can work in the tools you use.' },
  agent: { title: 'Your first agent', purpose: 'Meet the colleague who answers first and builds your team with you.' },
};

/** The routes the layer takes the main zone on: My day ('home' is its alias). */
export const LAYER_VIEWS: readonly string[] = ['home', 'day'];

/** The layer shows on this window: settings loaded, step not 'done', the owner's window, not a preview page. */
export function firstRunShown(settings: Pick<Settings, 'onboarding'> | null, owner: boolean, preview: boolean): boolean {
  return Boolean(settings) && owner && !preview && settings!.onboarding.step !== 'done';
}

const indexOf = (step: OnboardingStep) => (CARDS as readonly OnboardingStep[]).indexOf(step);

/** A stored step as a card (an unknown one starts at the first). */
export const cardOf = (step: OnboardingStep | undefined): Card => (step && indexOf(step) >= 0 ? step as Card : FIRST_STEP);

/** The step after `step` ('done' after the last). */
export function nextStep(step: OnboardingStep): OnboardingStep {
  const index = indexOf(step);
  return index < 0 || index >= CARDS.length - 1 ? 'done' : CARDS[index + 1];
}

/** The step before `step` (the first stays first). */
export function previousStep(step: OnboardingStep): OnboardingStep {
  const index = indexOf(step);
  return index <= 0 ? CARDS[0] : CARDS[index - 1];
}

/** "Step 2 of 4". */
export function stepText(step: OnboardingStep): string {
  return `Step ${Math.max(0, indexOf(step)) + 1} of ${CARDS.length}`;
}

/** Account states that may still serve a model (cooling ends, unknown is not checked yet). */
const SERVING: ReadonlySet<AccountState> = new Set(['ok', 'cooling', 'unknown']);

/**
 * True when no model can answer: the model list has no available chat model – or, while the list
 * is empty (not loaded yet, or nothing connected), no enabled model account can serve one.
 */
export function noUsableModel(models: readonly ModelInfo[], accounts: readonly Account[]): boolean {
  if (models.length) return !models.some((model) => model.available && isChatModel(model));
  return !accounts.some((account) => account.enabled && SERVING.has(account.state));
}

/** This PC's request was accepted as the CEO's own PC: this PC skips the rest of the first run. */
export function linkedAsCeo(out: Pick<RemoteOutgoing, 'status' | 'role'> | undefined): boolean {
  return out?.status === 'accepted' && out.role === 'ceo';
}

/** The profile step's write: trimmed name and company and the language, only what changed. */
export function profilePatch(current: Pick<Settings['profile'], 'name' | 'company'> & { language?: string } | undefined, name: string, company: string, language?: string): Partial<Settings['profile']> | undefined {
  const next = { name: name.trim().slice(0, 120), company: company.trim().slice(0, 200) };
  const patch: Partial<Settings['profile']> = {};
  if (next.name !== (current?.name ?? '')) patch.name = next.name;
  if (next.company !== (current?.company ?? '')) patch.company = next.company;
  if (language && LANGUAGE_CODE.test(language) && language !== current?.language) patch.language = language;
  return Object.keys(patch).length ? patch : undefined;
}

const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** The languages the profile step offers (the agents speak any; these are the common ones). */
export const LANGUAGES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'en', name: 'English' }, { code: 'de', name: 'Deutsch' }, { code: 'fr', name: 'Français' }, { code: 'es', name: 'Español' },
  { code: 'it', name: 'Italiano' }, { code: 'nl', name: 'Nederlands' }, { code: 'pt', name: 'Português' }, { code: 'pl', name: 'Polski' },
  { code: 'tr', name: 'Türkçe' }, { code: 'uk', name: 'Українська' }, { code: 'ja', name: '日本語' }, { code: 'zh', name: '中文' },
];

/** The language list with `current` (the PC's, a longer code) first when it is not one of them, its base code selected otherwise. */
export function languageOptions(current: string | undefined): { options: ReadonlyArray<{ code: string; name: string }>; selected: string } {
  const code = (current ?? 'en').trim() || 'en';
  if (LANGUAGES.some((language) => language.code === code)) return { options: LANGUAGES, selected: code };
  const base = code.split('-')[0];
  const known = LANGUAGES.find((language) => language.code === base);
  return { options: [{ code, name: known ? `${known.name} (${code})` : code }, ...LANGUAGES], selected: code };
}
