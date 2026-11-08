// AF-019: Settings › Updates – the version with its update state and action, "Check for updates now", where updates come
// from (this build's fork desquerteur/OpenAutark, the upstream teydra/OpenAutark or another repository), automatic
// checks on/off, the channel (stable or prereleases) and the automatic download. Changes go to main
// (bridge.updates.setSource → <data>/update-source.json); the state comes back as UpdateState.
// Without the desktop bridge (phone, browser) the page only says where updates are managed.
// Owns: these rows. Never: checks or installs itself (main's UpdateService does).

import { useState } from 'preact/hooks';
import { bridge } from '../lib/platform.ts';
import { preferences, systemInfo, updatePreferences, updateState } from '../lib/store.ts';
import { aboutUpdateAction, autoDownloadApplies } from '../shell/update-control.ts';
import { act, ActionButton, Group, Note, Row, Segmented, Select, TextField, Toggle, useBusy } from './controls.tsx';
import { canCheckNow, repositoryOf, SOURCE_OPTIONS, sourceChoice, updateStatusText, type SourceChoice } from './updates-text.ts';

export function UpdatesPage() {
  const state = updateState.value;
  const updates = bridge?.updates;
  const [checking, runCheck] = useBusy();
  const [custom, setCustom] = useState(false);
  if (!updates) {
    return (
      <Group title="Updates" id="settings-updates" tour="updates">
        <Row label="Updates" hint="Updates are managed in the desktop app on the PC (Settings › Updates there)" />
      </Group>
    );
  }
  const repository = state?.source ?? '';
  const choice: SourceChoice = custom ? 'custom' : sourceChoice(state?.source);
  const action = aboutUpdateAction(state);
  const development = state?.status === 'development';
  const setSource = (patch: Parameters<NonNullable<typeof updates.setSource>>[0]) =>
    void act(async () => { if (!updates.setSource) throw new Error('This version cannot change the update source.'); await updates.setSource(patch); }, 'Could not save');
  const pick = (next: SourceChoice) => {
    const repo = repositoryOf(next);
    setCustom(next === 'custom');
    if (repo) setSource({ repository: repo });
  };

  return (
    <Group title="Updates" id="settings-updates" tour="updates" hint="Updates come from the GitHub releases of the repository below">
      <Row label={`Version ${systemInfo.value?.version ?? state?.version ?? '–'}`} hint={[updateStatusText(state, systemInfo.value?.platform), action?.hint].filter(Boolean).join(' · ')} reserve>
        {action && <ActionButton label={action.label} variant={action.primary ? 'primary' : 'secondary'} onClick={() => void act(() => updates.apply(), 'Update failed')} />}
      </Row>
      <Row label="Check for updates now" hint={repository ? `Asks ${repository} for a newer version` : undefined} reserve>
        <ActionButton label="Check now" busy={checking} disabled={!canCheckNow(state) || !updates.check}
          onClick={() => void runCheck(async () => { await updates.check?.(); })} />
      </Row>
      {development && <Row label="" hint={<Note>A development build never updates itself – the source is still saved for the installed app.</Note>} />}
      <Row label="Source" hint={SOURCE_OPTIONS.find((option) => option.value === choice)?.hint}>
        <Select label="Update source" value={choice} options={SOURCE_OPTIONS} onChange={pick} />
      </Row>
      {choice === 'custom' && (
        <Row label="Repository" hint="GitHub owner/name, for example desquerteur/OpenAutark">
          <TextField label="Repository" placeholder="owner/name" value={sourceChoice(repository) === 'custom' ? repository : ''} maxLength={200}
            onCommit={(value) => { if (value.trim()) setSource({ repository: value.trim() }); }} />
        </Row>
      )}
      <Row label="Check automatically" hint="At start and every few minutes while Autark runs">
        <Toggle label="Check for updates automatically" checked={state?.autoCheck !== false} onChange={(autoCheck) => setSource({ autoCheck })} />
      </Row>
      <Row label="Channel" hint={state?.channel === 'prerelease' ? 'Also offers test versions (prereleases)' : 'Only finished releases'}>
        <Segmented label="Update channel" value={state?.channel ?? 'stable'}
          options={[{ value: 'stable', label: 'Stable' }, { value: 'prerelease', label: 'Prereleases' }]}
          onChange={(channel) => setSource({ channel })} />
      </Row>
      {autoDownloadApplies(state) && (
        <Row label="Download updates automatically" hint="Restarts only when you are idle" disabled={development}>
          <Toggle label="Download updates automatically" checked={preferences.value.autoDownloadUpdates} disabled={development}
            onChange={(autoDownloadUpdates) => void act(() => updatePreferences({ autoDownloadUpdates }), 'Could not save')} />
        </Row>
      )}
      {state?.status === 'available' && state.releaseNotes && (
        <Row label={state.releaseName || `What's new in ${state.availableVersion ?? 'the update'}`} stack>
          <div class="update-notes">{state.releaseNotes}</div>
        </Row>
      )}
    </Group>
  );
}
