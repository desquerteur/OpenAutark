// The first-run layer: while settings.onboarding.step is not 'done' it is the main zone's content in
// Home's place (shell/views.ts asks first-run.ts firstRunActive) – no route or window of its own, the
// frame, the sidebar and the header row stay where they are. A new install starts with the feedback tour
// (ui/tour/TourPlayer.tsx, no "Step n of 2"); its Continue or Skip lead to the cards: AI (AiCard.tsx),
// then About you (AboutCard.tsx), one at a time in a fixed column. About you ends the layer
// (onboarding.start opens the Manager's chat with the app's start text as the person's line). Beside Skip, on the
// computer, "Connect to my other device" opens the Connect card (ConnectCard.tsx) in the cards' column; Back returns to the
// tour. B-078: a company started from the company menu's "+" as my other device or as an employee (companies.list
// current entry's `start`) opens that card at once, preset that way. The phone stack draws its own top row (shell/views.ts tabTitle), so the layer draws its header row on the desktop only.
// Owns: the layer's frame and the card switch. Never: a card's choices (the cards), the step rules
// (first-run-model.ts) or the tour itself (ui/tour).

import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { JoinRole } from '../../shared/model/remote.ts';
import { Header } from '../lib/header.tsx';
import { platform } from '../lib/platform.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { isMobile, settings } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { TourPlayer } from '../tour/TourPlayer.tsx';
import { FIRST_RUN_TITLE, TOUR_STEP, nextStep, stepText } from './first-run-model.ts';
import { goStep } from './first-run.ts';
import { AboutCard } from './AboutCard.tsx';
import { AiCard } from './AiCard.tsx';
import { ConnectCard } from './ConnectCard.tsx';

/** The Connect card is open over the tour, as my other device or as an employee (outlives a remount across the phone layout). */
const connecting = signal<JoinRole | null>(null);
/** B-078: the start this company was asked for (company menu "+", `--start=`) opens the card once. */
let presetRead = false;

function readPreset(): void {
  if (presetRead || platform !== 'desktop' || !can('companies.list')) return;
  presetRead = true;
  rpc.call('companies.list').then(({ companies }) => {
    const start = companies.find((company) => company.current)?.start;
    if ((start === 'mine' || start === 'employee') && (settings.value?.onboarding.step ?? TOUR_STEP) === TOUR_STEP) connecting.value = start === 'mine' ? 'ceo' : 'employee';
  }, () => undefined);
}

/** The tour is through (Continue or Skip): the first card. */
function leaveTour(): void {
  goStep(nextStep(TOUR_STEP)).catch((error) => toastError(error, 'Could not continue'));
}

export function FirstRun() {
  const step = settings.value?.onboarding.step ?? 'ai';
  useEffect(readPreset, []);
  const connect = platform === 'desktop' && can('remote.connect') ? () => { connecting.value = 'ceo'; } : undefined;
  const role = connecting.value;
  const card = step === TOUR_STEP ? (connect && role ? <ConnectCard key={`connect-${role}`} role={role} onClose={() => { connecting.value = null; }} /> : null)
    : step === 'ai' ? <AiCard key="ai" /> : <AboutCard key="about" />;
  return (
    <div class="first-run-view">
      {!isMobile.value && <Header zone="main" class="first-run-header" title={FIRST_RUN_TITLE} />}
      {card === null
        ? <div class="first-run-tour"><TourPlayer mode="page" onDone={leaveTour} onConnect={connect} /></div>
        : (
          <div class="first-run-scroll">
            <div class="first-run-column">
              <p class="first-run-step" aria-live="polite">{stepText(step)}</p>
              {card}
            </div>
          </div>
        )}
    </div>
  );
}
