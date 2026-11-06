// The first-run layer's pure rules (FirstRun.tsx and its cards, tested in test/unit/ui/first-run.test.ts):
// when the layer shows (settings.onboarding.step not 'done', on the owner's window, never in a hidden
// preview), the step order – the feedback tour first on a new install (ui/tour, no card), then two cards:
// AI (AiCard.tsx) and About you (AboutCard.tsx) –, whether any model can answer (the AI card's Continue, Home's
// "No AI" notice), the About card's profile write and when "Connect to my other device" (ConnectCard.tsx) ends the layer.
// Owns: these pure checks. Never: reads signals, calls the runtime or renders.

import type { Account, AccountState, ModelInfo } from '../../shared/model/providers.ts';
import type { RemoteOutgoing } from '../../shared/model/remote.ts';
import type { OnboardingStep, Settings } from '../../shared/model/system.ts';
import { isChatModel } from '../lib/model-fit.ts';

/** The cards in order ('done' ends the layer; the tour before them is the player, not a card). */
export const CARDS = ['ai', 'about'] as const satisfies readonly OnboardingStep[];
export const TOUR_STEP: OnboardingStep = 'tour';
/** The layer's title: the computer's header row and the phone's top row. */
export const FIRST_RUN_TITLE = 'Set up';

/** The layer shows on this window: settings loaded, step not 'done', the owner's window, not a preview page. */
export function firstRunShown(settings: Pick<Settings, 'onboarding'> | null, owner: boolean, preview: boolean): boolean {
  return Boolean(settings) && owner && !preview && settings!.onboarding.step !== 'done';
}

const indexOf = (step: OnboardingStep) => (CARDS as readonly OnboardingStep[]).indexOf(step);

/** The card after `step` ('done' after the last). */
export function nextStep(step: OnboardingStep): OnboardingStep {
  if (step === TOUR_STEP) return CARDS[0];
  const index = indexOf(step);
  return index < 0 || index >= CARDS.length - 1 ? 'done' : CARDS[index + 1];
}

/** The card before `step` (the first stays first; the tour is never gone back to). */
export function previousStep(step: OnboardingStep): OnboardingStep {
  const index = indexOf(step);
  return index <= 0 ? CARDS[0] : CARDS[index - 1];
}

/** "Step 2 of 2" ('' for the tour, which is no card). */
export function stepText(step: OnboardingStep): string {
  if (step === TOUR_STEP) return '';
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

/** The About card's profile write: trimmed name and company, only what changed. */
export function profilePatch(current: Pick<Settings['profile'], 'name' | 'company'> | undefined, name: string, company: string): Partial<Settings['profile']> | undefined {
  const next = { name: name.trim().slice(0, 120), company: company.trim().slice(0, 200) };
  const patch: Partial<Settings['profile']> = {};
  if (next.name !== (current?.name ?? '')) patch.name = next.name;
  if (next.company !== (current?.company ?? '')) patch.company = next.company;
  return Object.keys(patch).length ? patch : undefined;
}
