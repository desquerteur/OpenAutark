// The first run's AI card: the model setup Settings › Models shows too (settings/ModelSetup.tsx – the plans on this
// PC with their state and the four buttons Claude plan, Codex plan, API key, Local server – the API key button opens
// the one connection form, provider → key → Test), without the use rows. Continue goes to the next card and
// waits until a model can answer: a plan, an API key or a local server all count.
// Owns: this card. Never: settings writes (the uses stay as they are; Settings › Models picks one).

import { useState } from 'preact/hooks';
import { accounts, models } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { Button } from '../lib/ui.tsx';
import { ModelSetup } from '../settings/ModelSetup.tsx';
import { nextStep, noUsableModel } from './first-run-model.ts';
import { goStep } from './first-run.ts';
import { Card } from './parts.tsx';

export function AiCard() {
  const [busy, setBusy] = useState(false);
  const silent = noUsableModel(models.value, accounts.value);
  const next = () => {
    setBusy(true);
    goStep(nextStep('ai')).catch((error) => toastError(error, 'Could not continue')).finally(() => setBusy(false));
  };
  return (
    <Card id="first-run-ai" title="AI" actions={
      <Button variant="primary" busy={busy} disabled={silent} title={silent ? 'Connect one AI first' : undefined} onClick={next}>Continue</Button>
    }>
      <div class="first-run-rows"><ModelSetup /></div>
    </Card>
  );
}
