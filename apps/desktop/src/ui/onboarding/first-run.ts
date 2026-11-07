// The setup assistant's state and actions for FirstRun.tsx, its cards, shell/views.ts (which draws the
// layer on My day) and the command palette: whether the layer shows now (first-run-model.ts
// firstRunShown over the settings signal and the owner's window), moving to another step
// (settings.onboarding.step), the end of the layer (onboarding.start: the Manager's first chat opens with the
// app's start text as the person's own line, which the Manager answers)
// and "Set up again" (onboarding.reset: the assistant again from its first step, on Home).
// Owns: these signals and calls. Never: decides what a card offers (first-run-model.ts) or renders.

import type { OnboardingStep, SettingsPatch } from '../../shared/model/system.ts';
import '../../shared/model/onboarding.ts'; // onboarding.start / onboarding.reset (module augmentation)
import { navigate } from '../lib/router.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { conversations, settings, updateSettings, upsertById } from '../lib/store.ts';
import { firstRunShown } from './first-run-model.ts';

export { managerAgent, managerFirstChat } from './manager.ts';

/** The layer shows on this window now (reactive: reads the settings and session signals). */
export function firstRunActive(): boolean {
  return firstRunShown(settings.value, can('onboarding.start'), false);
}

/** Another card (with whatever else that card decided in the same write). */
export function goStep(step: OnboardingStep, patch: SettingsPatch = {}): Promise<void> {
  return updateSettings({ ...patch, onboarding: { ...patch.onboarding, step } });
}

/** The cards are through: the Manager's first chat opens; the runtime posts the app's start text there as the person's line. */
export async function finishFirstRun(): Promise<void> {
  const { conversationId } = await rpc.call('onboarding.start');
  // A chat the runtime just made arrives as an event as well; fetch it so it opens at once.
  if (!conversations.value.some((chat) => chat.id === conversationId)) {
    const summary = await rpc.call('chats.get', { id: conversationId }).catch(() => null);
    if (summary) upsertById(conversations, summary);
  }
  navigate({ view: 'chat', id: conversationId });
}

/** "Set up team again": onboarding is open again – the first-run layer from its first card, on Home. */
export async function setUpTeamAgain(): Promise<void> {
  await rpc.call('onboarding.reset');
  navigate({ view: 'home' });
}
