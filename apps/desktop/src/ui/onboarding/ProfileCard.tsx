// AF-002: the setup assistant's first step, About you: the language the agents speak with you (profile.language – it
// starts as this PC's), your name and the company (settings.profile, the name and company also in Settings › General).
// Continue saves what changed and goes to the AI step; Skip goes on without saving. On the computer, "Connect to my
// other device" (the Connect card, FirstRun.tsx) sits at the row's start – a PC that joins another company skips the rest.
// The typed values survive a remount (desktop ↔ phone shell) until Continue.
// Owns: this card. Never: creates agents or changes a setting other than the profile.

import { useState } from 'preact/hooks';
import { settings, updateSettings } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { Button } from '../lib/ui.tsx';
import { Select } from '../settings/controls.tsx';
import { STEP_INFO, languageOptions, nextStep, profilePatch } from './first-run-model.ts';
import { goStep } from './first-run.ts';
import { Card, StatusLine } from './parts.tsx';

const value = (event: Event) => (event.currentTarget as HTMLInputElement).value;

/** What the person typed outlives a remount (the window switching between desktop and phone shell) until Continue. */
const draft: { name?: string; company?: string; language?: string } = {};

export function ProfileCard(props: { onConnect?: () => void }) {
  const profile = settings.value?.profile;
  const languages = languageOptions(profile?.language);
  const [name, setNameState] = useState(draft.name ?? profile?.name ?? '');
  const [company, setCompanyState] = useState(draft.company ?? profile?.company ?? '');
  const [language, setLanguageState] = useState(draft.language ?? languages.selected);
  const setName = (next: string) => { draft.name = next; setNameState(next); };
  const setCompany = (next: string) => { draft.company = next; setCompanyState(next); };
  const setLanguage = (next: string) => { draft.language = next; setLanguageState(next); };
  const [busy, setBusy] = useState<'next' | 'skip' | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  const go = async (save: boolean) => {
    setBusy(save ? 'next' : 'skip');
    setError(undefined);
    try {
      const patch = save ? profilePatch(settings.value?.profile, name, company, language) : undefined;
      await goStep(nextStep('profile'), patch ? { profile: patch } : {});
      delete draft.name; delete draft.company; delete draft.language; // saved: a later "Set up again" starts from the settings
    } catch (failure) { toastError(failure, 'Could not continue'); setError('Could not save – try again.'); } finally { setBusy(null); }
  };
  const info = STEP_INFO.profile;
  return (
    <Card id="first-run-profile" title={info.title} purpose={info.purpose} actions={<>
      {props.onConnect && <button type="button" class="text-button first-run-connect" disabled={busy !== null} onClick={props.onConnect}>Connect to my other device</button>}
      <span class="first-run-spacer" />
      <Button variant="ghost" busy={busy === 'skip'} disabled={busy !== null} onClick={() => void go(false)}>Skip</Button>
      <Button variant="primary" busy={busy === 'next'} disabled={busy !== null} onClick={() => void go(true)}>Continue</Button>
    </>}>
      <div class="first-run-fields">
        <label class="first-run-field first-run-field-wide">
          <span class="field-label">Language your agents speak with you</span>
          <Select native label="Language" value={language} options={languages.options.map((entry) => ({ value: entry.code, label: entry.name }))} onChange={setLanguage} />
        </label>
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
