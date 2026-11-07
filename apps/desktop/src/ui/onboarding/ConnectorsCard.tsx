// AF-002: the setup assistant's optional step, Connect your tools: the same rows as Settings › Apps (settings/AppsPage.tsx –
// what is connected, the one-click catalog with GitHub, an MCP server by address or command, a mailbox), so whatever is
// connected here shows there and the AI's skill connect-apps edits the same files. Continue and Skip both go on to the
// first agent; nothing is required.
// Owns: this card. Never: its own connector logic (AppsPage and apps-add.tsx do it).

import { useState } from 'preact/hooks';
import { toastError } from '../lib/toasts.ts';
import { Button } from '../lib/ui.tsx';
import { AppsPage } from '../settings/AppsPage.tsx';
import { STEP_INFO, nextStep, previousStep } from './first-run-model.ts';
import { goStep } from './first-run.ts';
import { Card } from './parts.tsx';

export function ConnectorsCard() {
  const [busy, setBusy] = useState<'next' | 'skip' | 'back' | null>(null);
  const move = (kind: 'next' | 'skip' | 'back') => {
    setBusy(kind);
    goStep(kind === 'back' ? previousStep('connectors') : nextStep('connectors')).catch((error) => toastError(error, 'Could not continue')).finally(() => setBusy(null));
  };
  const info = STEP_INFO.connectors;
  return (
    <Card id="first-run-connectors" title={info.title} purpose={info.purpose} actions={<>
      <Button variant="secondary" busy={busy === 'back'} disabled={busy !== null} onClick={() => move('back')}>Back</Button>
      <span class="first-run-spacer" />
      <Button variant="ghost" busy={busy === 'skip'} disabled={busy !== null} onClick={() => move('skip')}>Skip</Button>
      <Button variant="primary" busy={busy === 'next'} disabled={busy !== null} onClick={() => move('next')}>Continue</Button>
    </>}>
      <div class="first-run-apps"><AppsPage /></div>
    </Card>
  );
}
