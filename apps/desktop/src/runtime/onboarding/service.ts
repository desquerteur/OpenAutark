// The runtime side of the first-run layer (ui/onboarding/FirstRun.tsx). The layer shows while
// settings.onboarding.step is not 'done'; its cards make their own choices through the existing methods
// (accounts, settings). start() ends the layer: step 'done' and completed, the Manager's first chat
// (shared/text/manager-chat.ts; when there is none, the owner's default 1:1 with it, chat/direct.ts) and the
// app's start text (brief.ts) posted there as the person's own line, addressed to the Manager: from there on it is
// an ordinary message (one 'message' wake, one turn, the route of a person's request). reset() ("Set up again",
// owner): not completed, step 'profile' – the setup assistant returns until the next start().
// Owns: these state changes and posting that line. Never: writes as the person anything but the start text,
// invents profile facts, or changes accounts.

import type { RuntimeServices } from '../contracts.ts';
import '../../shared/model/onboarding.ts'; // the first-run methods (module augmentation)
import { HUMAN_ID } from '../../shared/ids.ts';
import { managerAgent, managerFirstChat } from '../../shared/text/manager-chat.ts';
import { findOrCreateDirect } from '../chat/direct.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { setupBrief } from './brief.ts';

export interface OnboardingDeps {
  services: () => RuntimeServices;
}

export class Onboarding {
  private readonly deps: OnboardingDeps;

  constructor(deps: OnboardingDeps) {
    this.deps = deps;
  }

  /** "Set up again" (Settings › General, Team › Add, the palette): the setup assistant from its first step. */
  reset(): void {
    this.deps.services().settings.update({ onboarding: { completed: false, step: 'profile' } });
  }

  /** The layer is through: onboarding done, the Manager's first chat and the start text as the person's line (once, also when asked twice). */
  start(): { conversationId: string } {
    const s = this.deps.services();
    const manager = managerAgent(s.org.list());
    if (!manager) throw new WorkforceError('not_found', 'There is no Manager on the team.');
    const conversationId = managerFirstChat(s.chats.list(), manager.id)?.id ?? findOrCreateDirect(s, HUMAN_ID, manager.id, { createdBy: HUMAN_ID });
    const line = setupBrief(s);
    const last = s.chats.messages(conversationId, { limit: 1 }).at(-1);
    if (line && !(last?.authorId === HUMAN_ID && last.body === line)) s.chats.send({ conversationId, body: line, authorId: HUMAN_ID, authorKind: 'human', mentions: [manager.id] });
    s.settings.update({ onboarding: { completed: true, step: 'done' } });
    s.log.info('first run done', { managerId: manager.id, conversationId });
    return { conversationId };
  }
}
