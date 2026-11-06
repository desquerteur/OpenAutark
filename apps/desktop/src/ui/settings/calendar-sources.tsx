// Settings › Calendar › Calendars: every connected calendar with what it is, its sync state (syncing, last sync, the
// runtime's error sentence, an expired Google sign-in with "Connect again"), Show in My day and Remove; Sync now; "Add
// calendar by link (ICS)"; "Connect Google Calendar" – disabled with one honest line while no client ID is set – and "Use
// your own Google app" (a row whose Set up opens a dialog: the client ID into settings.calendar, the client secret into the
// vault; settings keep its id only). Reloaded by 'calendar.sources' and settings events and on reconnect (no polling).
// Every control is gated with can(): a phone sees the list only.
// Owns: these rows and the Google app dialog. Never: keeps a calendar link or a secret beyond the field (or the open
// dialog) it is typed into, or words statuses itself (calendar-model.ts).

import { useEffect, useState } from 'preact/hooks';
import type { CalendarSource } from '../../shared/model/calendar.ts';
import { confirm, Dialog, DialogActions } from '../lib/dialog.tsx';
import { openExternal } from '../lib/platform.ts';
import { errorText, rpc } from '../lib/rpc.ts';
import { can, isOwner } from '../lib/session.ts';
import { settings, updateSettings } from '../lib/store.ts';
import { Button } from '../lib/ui.tsx';
import { clientIdValid, GOOGLE_CLIENT_SUFFIX, googleHint, googleView, linkValid, sourceKind, syncLine, type GoogleView } from './calendar-model.ts';
import { act, CLEAR, Group, Note, Row, Toggle, useAsync, useBusy } from './controls.tsx';

const GOOGLE_TOKEN_HOST = 'oauth2.googleapis.com';

/** Starts the Google consent; the browser opens on the PC (the link is kept in case it did not). */
async function startGoogle(setLink: (url: string) => void): Promise<void> {
  const result = await act(() => rpc.call('calendar.connectGoogle', {}), 'Could not connect Google Calendar');
  if (result?.authUrl) setLink(result.authUrl);
}

function SourceRow(props: { source: CalendarSource; onChanged: () => void; onConnect: () => void }) {
  const { source } = props;
  const [busy, run] = useBusy();
  const line = syncLine(source);
  const room = source.ownerId.startsWith('room:'); // B-078: a room's calendar – booked by the head of staff, never in My day
  const remove = async () => {
    const body = source.kind === 'google' ? 'Its events leave My day. Nothing is deleted in Google.' : 'Its events leave My day. The calendar itself stays as it is.';
    if (!(await confirm({ title: `Remove ${source.label}?`, body, confirmLabel: 'Remove', danger: true }))) return;
    await act(async () => { await rpc.call('calendar.removeSource', { id: source.id }); props.onChanged(); }, 'Could not remove');
  };
  return (
    <Row label={source.label} hint={<>{room ? 'Room calendar' : sourceKind(source)} · <span class={line.problem ? 'calendar-settings-problem' : undefined}>{line.text}</span></>} reserve>
      <div class="set-inline">
        {source.status === 'reconnect' && can('calendar.connectGoogle') && <button type="button" class="button small" onClick={props.onConnect}>Connect again</button>}
        {can('calendar.updateSource') && !room && (
          <Toggle label={`Show ${source.label} in My day`} checked={source.visible} disabled={busy}
            onChange={(visible) => void run(async () => { await rpc.call('calendar.updateSource', { id: source.id, visible }); props.onChanged(); })} />
        )}
        {can('calendar.removeSource') && <button type="button" class="button ghost small danger" disabled={busy} onClick={() => void remove()}>Remove</button>}
      </div>
    </Row>
  );
}

function AddLink(props: { onAdded: () => void }) {
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = linkValid(url) && !busy;
  const add = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.call('calendar.addIcs', { url: url.trim(), ...(label.trim() ? { label: label.trim() } : {}) });
      setUrl('');
      setLabel('');
      props.onAdded();
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };
  const enter = (event: KeyboardEvent) => { if (event.key === 'Enter') void add(); };
  return (
    <Row label="Add calendar by link (ICS)" stack
      hint={error ? <span class="calendar-settings-problem">{error}</span> : 'Read only. In Google Calendar: Settings › your calendar › Secret address in iCal format.'}>
      <div class="set-inline wrap calendar-settings-form">
        <input class="set-input wide" type="url" inputMode="url" aria-label="Calendar link" placeholder="https://… or webcal://…" autoComplete="off" spellcheck={false}
          value={url} disabled={busy} onInput={(event) => setUrl((event.currentTarget as HTMLInputElement).value)} onKeyDown={enter} />
        <input class="set-input" type="text" aria-label="Calendar name" placeholder="Name (optional)" maxLength={80}
          value={label} disabled={busy} onInput={(event) => setLabel((event.currentTarget as HTMLInputElement).value)} onKeyDown={enter} />
        <button type="button" class="button small" disabled={!ready} onClick={() => void add()}>{busy ? 'Adding…' : 'Add'}</button>
      </div>
    </Row>
  );
}

/** "Use your own Google app": the group's last row opens a dialog with the client ID (settings) and its secret (vault). */
function OwnGoogleApp() {
  const calendar = settings.value?.calendar ?? {};
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState(calendar.googleClientId ?? '');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const id = clientId.trim();
  const invalid = id !== '' && !clientIdValid(id);
  const changed = id !== (calendar.googleClientId ?? '') || secret.length > 0;
  // a client ID needs its secret: typed now or saved before (clearing the ID needs none)
  const needsSecret = id !== '' && !secret && !calendar.googleSecretId;
  const start = () => { setClientId(calendar.googleClientId ?? ''); setSecret(''); setError(undefined); setOpen(true); };
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      let secretId = calendar.googleSecretId;
      if (secret) secretId = (await rpc.call('secrets.save', { ...(secretId ? { id: secretId } : {}), label: 'Google Calendar client secret', kind: 'api_key', value: secret, tags: [`used with ${GOOGLE_TOKEN_HOST}`] })).id;
      await updateSettings({ calendar: { googleClientId: id || CLEAR, ...(secretId ? { googleSecretId: secretId } : {}) } });
      setOpen(false);
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };
  return (
    <>
      <Row label="Use your own Google app" hint="Client ID and secret of a Google Cloud desktop app">
        <button type="button" class="button secondary small" aria-haspopup="dialog" onClick={start}>Set up</button>
      </Row>
      <Dialog open={open} onClose={() => setOpen(false)} title="Use your own Google app" width={520} class="calendar-google-app anchored">
        <p class="dialog-text calendar-google-hint">Google Cloud › Credentials › OAuth client ID of type “Desktop app”. While that app is in “Testing”, the sign-in ends after 7 days.</p>
        <label class="field-label" for="calendar-client-id">Client ID</label>
        <input id="calendar-client-id" class="input" type="text" placeholder={`…${GOOGLE_CLIENT_SUFFIX}`} autoComplete="off" spellcheck={false}
          value={clientId} disabled={busy} onInput={(event) => setClientId((event.currentTarget as HTMLInputElement).value)} />
        <label class="field-label" for="calendar-client-secret">Client secret</label>
        <input id="calendar-client-secret" class="input" type="password" placeholder={calendar.googleSecretId ? 'Secret saved' : ''} autoComplete="off"
          value={secret} disabled={busy} onInput={(event) => setSecret((event.currentTarget as HTMLInputElement).value)} />
        <DialogActions message={error ?? (invalid ? `Client IDs end in ${GOOGLE_CLIENT_SUFFIX}` : needsSecret ? 'Enter the client secret to save' : undefined)} tone={error || invalid ? 'error' : 'muted'}>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!changed || invalid || needsSecret} onClick={() => void save()}>Save</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function GoogleConnect(props: { view: GoogleView; link: string | null; onConnect: () => void }) {
  const { view } = props;
  return (
    <Row label="Connect Google Calendar"
      hint={<>
        <span class={view.error && !view.waiting ? 'calendar-settings-problem' : undefined}>{googleHint(view)}</span>
        {view.waiting && props.link && <> <a href={props.link} onClick={(event) => { event.preventDefault(); openExternal(props.link!); }}>Open the sign-in page</a></>}
      </>}>
      <button type="button" class="button small" disabled={!view.configured || view.waiting} onClick={props.onConnect}>{view.waiting ? 'Waiting…' : 'Connect'}</button>
    </Row>
  );
}

export function CalendarsGroup() {
  const list = useAsync(() => (can('calendar.sources') ? rpc.call('calendar.sources') : Promise.resolve([] as CalendarSource[])), []);
  const google = useAsync(async () => googleView(can('calendar.google') ? await rpc.call('calendar.google') : undefined), []);
  const [link, setLink] = useState<string | null>(null);
  const [busy, run] = useBusy();
  useEffect(() => {
    const reload = () => { void list.reload(); void google.reload(); };
    const offs = [rpc.on('calendar.sources', reload), rpc.on('settings.updated', () => void google.reload()), rpc.onOpen(reload)];
    return () => offs.forEach((off) => off());
  }, [list.reload, google.reload]);
  const sources = list.data ?? [];
  const view = google.data ?? googleView(undefined);
  const connect = () => void startGoogle(setLink).then(() => google.reload());
  const syncing = sources.some((source) => source.status === 'syncing');
  const hasGoogle = sources.some((source) => source.kind === 'google');
  return (
    <Group title="Calendars"
      actions={can('calendar.sync') && sources.length > 0 && (
        <button type="button" class="button ghost small" disabled={busy || syncing} onClick={() => void run(async () => { list.set(await rpc.call('calendar.sync', {})); })}>
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      )}>
      {list.error && <Row label="Unavailable" hint={list.error} />}
      {/* the loading and empty rows reserve a hint line like a calendar's row: adding the first one moves nothing below */}
      {list.loading && !list.data && !list.error && <Row label={<Note>Loading…</Note>} reserve />}
      {list.data && !sources.length && <Row label={<Note>No calendar connected</Note>} reserve />}
      {sources.map((source) => <SourceRow key={source.id} source={source} onChanged={() => void list.reload()} onConnect={connect} />)}
      {can('calendar.addIcs') && <AddLink onAdded={() => void list.reload()} />}
      {can('calendar.connectGoogle') && (!hasGoogle || view.waiting || Boolean(view.error)) && <GoogleConnect view={view} link={link} onConnect={connect} />}
      {can('calendar.connectGoogle') && can('secrets.save') && isOwner() && <OwnGoogleApp />}
    </Group>
  );
}
