// The setup assistant (AF-002): while settings.onboarding.step is not 'done' it is the main zone's content on My day –
// 'home' and 'day' alike (shell/views.ts asks first-run.ts firstRunActive), so the rail's My day never hides it; elsewhere
// the status line says the setup is not finished, with Continue setup (setup-reminder.ts). No route or window of its own:
// the frame, the sidebar and the header row stay where they are. Four steps, one card at a time in a fixed column under
// "Step n of 4" and the step names: About you (ProfileCard.tsx), Connect an AI (AiCard.tsx), Connect your tools
// (ConnectorsCard.tsx) and Your first agent (AgentCard.tsx), each with one sentence on what it is for and a Skip. The last
// step's Start ends the layer (onboarding.start opens the Manager's chat with the app's start text as the person's line)
// and starts the spotlight tour. On the computer, "Connect to my other device" on the first step opens the Connect card
// (ConnectCard.tsx) in the cards' column; Back returns to the step. B-078: a company started from the company menu's "+" as
// my other device or as an employee (companies.list current entry's `start`) opens that card at once, preset that way.
// The phone stack draws its own top row (shell/views.ts tabTitle), so the layer draws its header row on the desktop only.
// Owns: the layer's frame and the card switch. Never: a card's choices (the cards) or the step rules (first-run-model.ts).

import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { JoinRole } from '../../shared/model/remote.ts';
import { Header } from '../lib/header.tsx';
import { platform } from '../lib/platform.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { isMobile, settings } from '../lib/store.ts';
import { FIRST_RUN_TITLE, FIRST_STEP, cardOf } from './first-run-model.ts';
import { AgentCard } from './AgentCard.tsx';
import { AiCard } from './AiCard.tsx';
import { ConnectCard } from './ConnectCard.tsx';
import { ConnectorsCard } from './ConnectorsCard.tsx';
import { StepBar } from './parts.tsx';
import { ProfileCard } from './ProfileCard.tsx';

/** The Connect card is open over the first step, as my other device or as an employee (outlives a remount across the phone layout). */
const connecting = signal<JoinRole | null>(null);
/** B-078: the start this company was asked for (company menu "+", `--start=`) opens the card once. */
let presetRead = false;

function readPreset(): void {
  if (presetRead || platform !== 'desktop' || !can('companies.list')) return;
  presetRead = true;
  rpc.call('companies.list').then(({ companies }) => {
    const start = companies.find((company) => company.current)?.start;
    if ((start === 'mine' || start === 'employee') && cardOf(settings.value?.onboarding.step) === FIRST_STEP) connecting.value = start === 'mine' ? 'ceo' : 'employee';
  }, () => undefined);
}

export function FirstRun() {
  const step = cardOf(settings.value?.onboarding.step);
  useEffect(readPreset, []);
  const connect = platform === 'desktop' && can('remote.connect') ? () => { connecting.value = 'ceo'; } : undefined;
  const role = step === FIRST_STEP && connect ? connecting.value : null;
  const card = role ? <ConnectCard key={`connect-${role}`} role={role} onClose={() => { connecting.value = null; }} />
    : step === 'profile' ? <ProfileCard key="profile" onConnect={connect} />
      : step === 'ai' ? <AiCard key="ai" />
        : step === 'connectors' ? <ConnectorsCard key="connectors" />
          : <AgentCard key="agent" />;
  return (
    <div class="first-run-view">
      {!isMobile.value && <Header zone="main" class="first-run-header" title={FIRST_RUN_TITLE} />}
      <div class="first-run-scroll">
        <div class="first-run-column">
          {!role && <StepBar step={step} />}
          {card}
        </div>
      </div>
    </div>
  );
}
