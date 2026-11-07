// The setup assistant's AI step: the model setup Settings › Models shows too (settings/ModelSetup.tsx – the plans on this
// PC with their state and the four buttons Claude plan, Codex plan, API key, Local server – the API key button opens
// the one connection form, provider → key → Test), without the use rows. Continue waits until a model can answer: a
// plan, an API key or a local server all count; the status line says when one does. AF-002: the assistant ends only
// with a model that answers or when the person skips on purpose – Skip for now asks once ("your agents can't answer
// until …") before it goes on. Back returns to About you.
// Owns: this card. Never: settings writes (the uses stay as they are; Settings › Models picks one).

import { useState } from 'preact/hooks';
import { confirm } from '../lib/dialog.tsx';
import { accounts, models } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { Button } from '../lib/ui.tsx';
import { ModelSetup } from '../settings/ModelSetup.tsx';
import { STEP_INFO, nextStep, noUsableModel, previousStep } from './first-run-model.ts';
import { goStep } from './first-run.ts';
import { Card, StatusLine } from './parts.tsx';

export const AI_READY_TEXT = 'An AI answers – you can go on.';
export const AI_MISSING_TEXT = 'Connect one AI above, or skip for now.';

export function AiCard() {
  const [busy, setBusy] = useState<'next' | 'skip' | 'back' | null>(null);
  const silent = noUsableModel(models.value, accounts.value);
  const move = (kind: 'next' | 'skip' | 'back') => {
    setBusy(kind);
    goStep(kind === 'back' ? previousStep('ai') : nextStep('ai')).catch((error) => toastError(error, 'Could not continue')).finally(() => setBusy(null));
  };
  const skip = async () => {
    const ok = await confirm({
      title: 'Go on without an AI?',
      body: 'Your agents can\'t answer until an AI is connected. You can connect one any time in Settings › Models.',
      confirmLabel: 'Skip for now',
    });
    if (ok) move('skip');
  };
  const info = STEP_INFO.ai;
  return (
    <Card id="first-run-ai" title={info.title} purpose={info.purpose} actions={<>
      <Button variant="secondary" busy={busy === 'back'} disabled={busy !== null} onClick={() => move('back')}>Back</Button>
      <span class="first-run-spacer" />
      {silent && <Button variant="ghost" busy={busy === 'skip'} disabled={busy !== null} onClick={() => void skip()}>Skip for now</Button>}
      <Button variant="primary" busy={busy === 'next'} disabled={silent || busy !== null} title={silent ? 'Connect one AI first' : undefined} onClick={() => move('next')}>Continue</Button>
    </>}>
      <div class="first-run-rows"><ModelSetup /></div>
      <StatusLine text={silent ? AI_MISSING_TEXT : AI_READY_TEXT} tone={silent ? undefined : 'ok'} />
    </Card>
  );
}
