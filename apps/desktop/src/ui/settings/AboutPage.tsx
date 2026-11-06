// Settings › About: the version with the real update state and its one action (shell/update-control.ts) and the automatic
// download where the app installs by itself, the data folder and settings.json (Open: the pane's file tab, a right click the
// system's own app – most things are set there, best by asking the AI), Back up (system.backup into the data folder, or a chosen one) and Restore (a backup folder → confirm →
// system.restore; Restart now applies it; afterwards its hint says what that start did), and the chat export (the same two
// places). The rows about the PC show only in the desktop window. Another company on this PC (B-072) says that updates
// install from the first company, in the same row, and its download toggle stays in place, disabled.
// Owns: these rows. Never: claims a restore happened before the start that applied it.

import { useEffect, useState } from 'preact/hooks';
import type { CompanyEntry } from '../../shared/model/companies.ts';
import type { RestoreStatus } from '../../shared/model/restore.ts';
import type { UpdateState } from '../../shared/model/system.ts';
import { confirm } from '../lib/dialog.tsx';
import { fileSize, time } from '../lib/format.ts';
import { bridge, platform } from '../lib/platform.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { conversations, preferences, systemInfo, updatePreferences, updateState } from '../lib/store.ts';
import { Button } from '../lib/ui.tsx';
import { aboutUpdateAction, autoDownloadApplies, installingText } from '../shell/update-control.ts';
import { act, Group, Row, Toggle, useAsync, useBusy } from './controls.tsx';
import { lastRestoreText } from './feedback-text.ts';
import { openInData, openInTab } from './open-file.ts';

function updateText(state: UpdateState | null): string {
  if (!state) return 'Unavailable';
  switch (state.status) {
    case 'development': return 'Development build – only an installed version updates itself';
    case 'checking': return 'Checking for updates…';
    case 'available': return `Version ${state.availableVersion ?? ''} available`;
    case 'downloading': return `Downloading ${Math.round(state.percent)}%`;
    case 'downloaded': return `Version ${state.availableVersion ?? ''} ready`;
    case 'installing': return installingText(state, systemInfo.value?.platform);
    case 'error': return state.message ?? 'Update failed';
    default: return 'Up to date';
  }
}

const open = (path: string) => void act(() => rpc.call('files.openPath', { path }), 'Could not open it');

function FolderRows() {
  const root = useAsync(() => rpc.call('system.root'), []);
  const path = root.data?.path;
  return (
    <>
      <Row label="Data folder" hint={path ?? '–'} reserve>
        <button type="button" class="button ghost small" disabled={!path} onClick={() => path && open(path)}>Open</button>
      </Row>
      <Row label="settings.json" hint="Tell your AI what to change – or edit the file yourself" reserve menu={() => [{ items: [{ label: 'Open with system', onSelect: () => void openInData('settings.json') }] }]}>
        <button type="button" class="button ghost small" disabled={!path} onClick={() => void openInTab('settings.json')}>Open</button>
      </Row>
    </>
  );
}

function BackupRows() {
  const [saved, setSaved] = useState<{ path: string; bytes: number; at: number } | null>(null);
  const [folder, setFolder] = useState('');
  const [status, setStatus] = useState<RestoreStatus | null>(null);
  const [backingUp, runBackup] = useBusy();
  const [restoring, runRestore] = useBusy();
  const pickFolder = bridge?.files.pickFolder;
  const loadStatus = () => rpc.call('system.restoreStatus').then(setStatus, () => undefined);
  useEffect(() => { void loadStatus(); return rpc.onOpen(() => { void loadStatus(); }); }, []);
  const backUp = async (dir?: string) => {
    const result = await runBackup(() => rpc.call('system.backup', dir ? { dir } : undefined));
    if (result) setSaved({ ...result, at: Date.now() });
  };
  const backUpTo = async () => {
    const dir = pickFolder && await act(() => pickFolder('backup'), 'Could not choose a folder');
    if (dir) await backUp(dir);
  };
  const choose = async () => {
    const dir = pickFolder && await act(() => pickFolder('restore'), 'Could not choose a folder');
    if (dir) setFolder(dir);
  };
  const restore = async () => {
    const target = folder.trim();
    if (!target || !(await confirm({ title: 'Restore from backup?', body: 'All current data is replaced at the next start. A copy of it stays in the data folder.', confirmLabel: 'Restore', danger: true }))) return;
    if (await runRestore(() => rpc.call('system.restore', { path: target }))) await loadStatus();
  };
  const staged = status?.staged;
  return (
    <>
      <Row label="Back up" reserve hint={saved ? `Saved ${time(saved.at)} · ${fileSize(saved.bytes)}` : "All data into the data folder, with encrypted secrets and the agents' website logins, not the AI sign-ins; keep it private"}>
        <Button variant="ghost" class="small" disabled={!saved} onClick={() => saved && open(saved.path)}>Show in folder</Button>
        {pickFolder && <Button variant="ghost" class="small" disabled={backingUp} onClick={() => void backUpTo()}>Back up to…</Button>}
        <Button variant="ghost" class="small" busy={backingUp} onClick={() => void backUp()}>Back up</Button>
      </Row>
      <Row label="Restore" reserve hint={staged ? `Ready: ${staged.path}` : status?.last ? lastRestoreText(status.last) : 'On another PC, sign in again and enter secrets again – they stay bound to this one'}>
        {staged
          ? <Button variant="primary" class="small" disabled={!status?.canRestart} onClick={() => void act(() => rpc.call('system.restartRuntime'), 'Could not restart')}>Restart now</Button>
          : (
            <>
              <input class="set-input" type="text" aria-label="Backup folder" placeholder="Backup folder" value={folder} spellcheck={false}
                onInput={(event) => setFolder((event.currentTarget as HTMLInputElement).value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void restore(); }} />
              {pickFolder && <Button variant="ghost" class="small" onClick={() => void choose()}>Choose…</Button>}
              <Button variant="ghost" class="small" busy={restoring} disabled={!folder.trim()} onClick={() => void restore()}>Restore</Button>
            </>
          )}
      </Row>
    </>
  );
}

const MAX_EXPORT = 500; // chats.export takes at most 500 chats
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Every chat of the list as a folder with its messages and files (<data>/exports/chats-<time>). */
function ChatExportRow() {
  const [done, setDone] = useState<{ dir: string; chats: number; messages: number; files: number } | null>(null);
  const [busy, run] = useBusy();
  const chats = conversations.value.filter((chat) => !chat.settings.system).map((chat) => chat.id).slice(0, MAX_EXPORT);
  const pickFolder = bridge?.files.pickFolder;
  const start = async (dir?: string) => {
    const result = await run(() => rpc.call('chats.export', { conversationIds: chats, ...(dir ? { dir } : {}) }));
    if (result) setDone(result);
  };
  const startTo = async () => {
    const dir = pickFolder && await act(() => pickFolder('chats'), 'Could not choose a folder');
    if (dir) await start(dir);
  };
  return (
    <Row label="Export chats" reserve hint={done ? `Exported ${count(done.chats, 'chat')} · ${count(done.messages, 'message')} · ${count(done.files, 'file')}` : 'Every chat as a folder with its messages and files'}>
      <Button variant="ghost" class="small" disabled={!done} onClick={() => done && open(done.dir)}>Show in folder</Button>
      {pickFolder && <Button variant="ghost" class="small" disabled={busy || !chats.length} onClick={() => void startTo()}>Export to…</Button>}
      <Button variant="ghost" class="small" busy={busy} disabled={!chats.length} onClick={() => void start()}>Export</Button>
    </Row>
  );
}

/** B-072: another company on this PC (its companies.list entry has an id) leaves updates to the first company. */
function useOtherCompany(): boolean {
  const list = useAsync<CompanyEntry[]>(async () => (platform === 'desktop' && can('companies.list') ? (await rpc.call('companies.list')).companies : []), []);
  return Boolean(list.data?.some((company) => company.current && company.id !== null));
}

export function AboutPage() {
  const update = updateState.value;
  const updates = bridge?.updates;
  const other = useOtherCompany();
  const action = updates && !other ? aboutUpdateAction(update) : null;
  const off = update?.status === 'development' || other;
  const hint = other ? 'Updates install from the first company on this PC' : [updateText(update), action?.hint].filter(Boolean).join(' · ');
  return (
    <Group title="About" id="settings-about">
      <Row label={`Version ${systemInfo.value?.version ?? update?.version ?? '–'}`} hint={hint} reserve>
        {updates && action && (
          <Button variant={action.primary ? 'primary' : 'secondary'} class="small" onClick={() => void act(async () => updates.apply(), 'Update failed')}>{action.label}</Button>
        )}
      </Row>
      {updates && autoDownloadApplies(update) && (
        <Row label="Download updates automatically" hint="Restarts only when you are idle" disabled={off}>
          <Toggle label="Download updates automatically" checked={preferences.value.autoDownloadUpdates} disabled={off} onChange={(autoDownloadUpdates) => void act(() => updatePreferences({ autoDownloadUpdates }), 'Could not save')} />
        </Row>
      )}
      {can('system.root') && <FolderRows />}
      {platform === 'desktop' && can('system.backup') && <BackupRows />}
      {platform === 'desktop' && can('chats.export') && <ChatExportRow />}
    </Group>
  );
}
