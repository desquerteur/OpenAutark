// Settings › General (B-078, D17 – owner 06.11.2026: only what is really worth it): profile (photo, name, company),
// appearance (the theme; finer looks are <data>/theme.css), notifications (the sound – to-dos, blockers and important
// messages always arrive, notify/service.ts) and behaviour (start at login and keep running when closed – desktop window
// only –, keep the screen on while agents work, Enter sends). Language and time zone come from the PC; the AI notices the
// language the person speaks and keeps profile.language and profile.notes itself (skill app-settings). The removed rows'
// keys stay in settings.json for the AI. Every row is a view on settings.json. A phone changes appearance and
// notifications only (its profile is read-only); the rows about the PC's window show only in the desktop window.
// Owns: these rows and their mapping onto Settings fields. Never: invents options without effect.

import type { DaySettings } from '../../shared/model/day-settings.ts';
import { daySettingsOf } from '../../shared/model/day-settings.ts';
import type { NotificationSettings, Preferences, Profile } from '../../shared/model/system.ts';
import { HumanAvatar } from '../lib/avatar.tsx';
import { uploadFile } from '../lib/files.ts';
import { isPersonSession } from '../lib/people.ts';
import { bridge, os } from '../lib/platform.ts';
import { isOwner, PC_NOTE } from '../lib/session.ts';
import { settings, systemInfo, updateSettings } from '../lib/store.ts';
import { act, CLEAR, Group, Row, Segmented, TextField, Toggle } from './controls.tsx';

const START_HINT = 'Opens the app when the PC starts and keeps agents working in the background';
const THEMES = [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] as const;

export function GeneralPage() {
  const value = settings.value;
  if (!value) return null;
  const profile = value.profile;
  const prefs = value.preferences;
  const notes = value.notifications;
  const day = daySettingsOf(value);
  const setProfile = (patch: Partial<Profile>) => act(() => updateSettings({ profile: patch }), 'Could not save');
  const setPrefs = (patch: Partial<Preferences>) => act(() => updateSettings({ preferences: patch }), 'Could not save');
  const setNotes = (patch: Partial<NotificationSettings>) => act(() => updateSettings({ notifications: patch }), 'Could not save');
  const setDay = (patch: Partial<DaySettings>) => act(() => updateSettings({ day: patch }), 'Could not save');
  const locked = !isOwner();
  const person = isPersonSession();
  const installed = systemInfo.value?.packaged === true; // the launcher registers only in the installed app
  const start = os === 'windows' ? 'Start with Windows' : 'Start at login';

  const pickPhoto = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void act(async () => { const ref = await uploadFile(file); await updateSettings({ profile: { avatarFileId: ref.fileId } }); }, 'Could not upload photo');
    };
    input.click();
  };

  return (
    <>
      <Group title="Profile" hint={locked ? (person ? 'Your name and title are set by the owner of the organisation' : PC_NOTE) : undefined}>
        <Row label="Photo">
          <div class="set-inline">
            <HumanAvatar size={36} />
            {!locked && <button type="button" class="button secondary small" onClick={pickPhoto}>Change</button>}
            {!locked && <button type="button" class="button ghost small" disabled={!profile.avatarFileId} onClick={() => void setProfile({ avatarFileId: CLEAR })}>Remove</button>}
          </div>
        </Row>
        <Row label="Your name"><TextField label="Your name" value={profile.name} disabled={locked} onCommit={(name) => void setProfile({ name: name.trim() })} /></Row>
        <Row label="Company" hint="Used by your agents"><TextField label="Company" value={profile.company} disabled={locked} onCommit={(company) => void setProfile({ company: company.trim() })} /></Row>
      </Group>

      <Group title="Appearance">
        <Row label="Theme" hint="More of the look is theme.css in the data folder – ask your AI" reserve>
          <Segmented label="Theme" value={prefs.theme} options={[...THEMES]} onChange={(theme) => void setPrefs({ theme })} />
        </Row>
      </Group>

      <Group title="Notifications">
        <Row label="Sound" hint="To-dos for you, blockers and important messages always arrive">
          <Toggle label="Sound" checked={notes.sound} onChange={(sound) => void setNotes({ sound })} />
        </Row>
      </Group>

      <Group title="Behavior">
        {bridge && (
          <>
            <Row label={start} hint={installed ? START_HINT : `${START_HINT} – in the installed app`} disabled={!installed}>
              <Toggle label={start} checked={prefs.openAtLogin} disabled={!installed} onChange={(openAtLogin) => void setPrefs({ openAtLogin })} />
            </Row>
            <Row label="Keep running when the window is closed" hint="Agents and schedules continue in the tray">
              <Toggle label="Keep running when closed" checked={prefs.closeToTray} onChange={(closeToTray) => void setPrefs({ closeToTray })} />
            </Row>
          </>
        )}
        <Row label="Keep the screen on while agents work" hint={locked ? PC_NOTE : 'Also keeps this PC awake for agent work at night'}>
          <Toggle label="Keep the screen on while agents work" checked={day.keepAwake} disabled={locked} onChange={(keepAwake) => void setDay({ keepAwake })} />
        </Row>
        <Row label="Enter sends" hint={prefs.enterSends ? 'Shift+Enter for a new line' : 'Ctrl+Enter sends'}>
          <Toggle label="Enter sends" checked={prefs.enterSends} onChange={(enterSends) => void setPrefs({ enterSends })} />
        </Row>
      </Group>
    </>
  );
}
