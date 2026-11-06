// The first run's last card, About you: the person's name and the company (settings.profile, also in
// Settings › General). Start saves them and ends the first run: onboarding.start has the runtime post the app's
// start text in the Manager's chat as the person's own line, and the Manager answers it.
// No dictation button here: the app's dictation hooks belong to their own fields (chat, My day, feedback).
// The typed name and company survive a remount (desktop ↔ phone shell) and Back until Start.
// Owns: this card. Never: creates agents or changes a setting other than the profile.

import { useState } from 'preact/hooks';
import { settings, updateSettings } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { Button } from '../lib/ui.tsx';
import { previousStep, profilePatch } from './first-run-model.ts';
import { finishFirstRun, goStep } from './first-run.ts';
import { Card, StatusLine } from './parts.tsx';

const value = (event: Event) => (event.currentTarget as HTMLInputElement).value;

/** What the person typed outlives a remount (the window switching between desktop and phone shell) until Start. */
const draft: { name?: string; company?: string } = {};

export function AboutCard() {
  const profile = settings.value?.profile;
  const [name, setNameState] = useState(draft.name ?? profile?.name ?? '');
  const [company, setCompanyState] = useState(draft.company ?? profile?.company ?? '');
  const setName = (next: string) => { draft.name = next; setNameState(next); };
  const setCompany = (next: string) => { draft.company = next; setCompanyState(next); };
  const [busy, setBusy] = useState<'start' | 'back' | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  const start = async () => {
    setBusy('start');
    setError(undefined);
    try {
      const patch = profilePatch(settings.value?.profile, name, company);
      if (patch) await updateSettings({ profile: patch });
      await finishFirstRun();
      delete draft.name; delete draft.company; // saved: a later "Set up again" starts from the settings
    } catch (failure) { toastError(failure, 'Could not start'); setError('Could not start – try again.'); } finally { setBusy(null); }
  };
  const back = async () => {
    setBusy('back');
    try {
      const patch = profilePatch(settings.value?.profile, name, company); // typed text is kept when going back
      await goStep(previousStep('about'), patch ? { profile: patch } : {});
    } catch (failure) { toastError(failure, 'Could not go back'); } finally { setBusy(null); }
  };
  return (
    <Card id="first-run-about" title="About you" actions={<>
      <Button variant="secondary" busy={busy === 'back'} disabled={busy !== null} onClick={() => void back()}>Back</Button>
      <Button variant="primary" busy={busy === 'start'} disabled={busy !== null} onClick={() => void start()}>Start</Button>
    </>}>
      <div class="first-run-fields">
        <label class="first-run-field">
          <span class="field-label">Your name</span>
          <input class="input" autocomplete="name" maxLength={120} value={name} onInput={(event) => setName(value(event))} />
        </label>
        <label class="first-run-field">
          <span class="field-label">Company</span>
          <input class="input" autocomplete="organization" maxLength={200} placeholder="Optional" value={company} onInput={(event) => setCompany(value(event))} />
        </label>
      </div>
      <StatusLine text={error} tone="error" />
    </Card>
  );
}
