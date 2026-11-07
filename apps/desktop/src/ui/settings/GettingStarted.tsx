// AF-002: Settings › General › Getting started – "Show the tour again" (the spotlight tour from its first step,
// tour/spotlight.ts) and "Run setup again" (the setup assistant from its first step on My day, after one confirm;
// onboarding/setup-again.ts). Only on the owner's window, where the setup runs.
// Owns: these two rows. Never: what the tour or the setup do.

import { can } from '../lib/session.ts';
import { startTour } from '../tour/spotlight.ts';
import { startSetupAgain } from '../onboarding/setup-again.ts';
import { ActionButton, Group, Row } from './controls.tsx';

/** "Show the tour again": from its first step; at its end the tour returns to this page. */
export function showTourAgain(): void {
  startTour();
}

export function GettingStarted() {
  if (!can('onboarding.start')) return null;
  return (
    <Group title="Getting started" id="settings-getting-started">
      <Row label="App tour" hint="Shows every part of the app, one at a time">
        <ActionButton label="Show the tour again" onClick={showTourAgain} />
      </Row>
      <Row label="Setup" hint="Language, AI, tools and your first agent – your agents and chats stay">
        <ActionButton label="Run setup again" onClick={() => void startSetupAgain()} />
      </Row>
    </Group>
  );
}
