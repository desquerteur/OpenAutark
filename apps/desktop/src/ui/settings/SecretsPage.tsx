// Settings › Secrets: the catalog like a skill list (owner 29.10.2026): every stored secret, login and card grouped by route
// with its name, purpose and kind – the same entries as the route files <data>/secrets/<route>.md – plus an entry of a file
// without a stored value ("Value missing"). Owner 04.11.2026 (no pop-up): above the list one fixed slot (SecretRows.tsx) –
// Name | Value rows, a pasted .env split into rows, a chosen or dropped file (a browser's or password manager's export, a
// .env, a JSON) – where 'Login, card or fields…' and a row's Edit open SecretForm in place of the rows; the route follows
// from the entry, and the AI and the files can name another. Delete asks first. Agents add their own (secrets.save) and
// the chat's Plus › Secret too. A secret the app keeps for itself (createdBy SYSTEM_ID) is not listed. A phone may add and look.
// Owner 04.11.2026 (select, export, see the email): on the PC a box in each row's label selects it – all are selected
// until deselected (secret-catalog.ts) – and the group's head holds All, None, the count, Export (one CSV file, its path
// in a toast) and Delete (asks once); a login shows its username where a value would be, a card its last digits.
// Owns: the list UI. Never: displays or logs a value.

import { useEffect, useState } from 'preact/hooks';
import type { SecretGroup, SecretInfo } from '../../shared/model/security.ts';
import { errorText, rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { pushToast, toastError } from '../lib/toasts.ts';
import { Button, confirm } from '../lib/ui.tsx';
import { act, Group, Row, useAsync } from './controls.tsx';
import type { SecretTarget } from './SecretForm.tsx';
import {
  catalogEntries, deleteEntries, deleteQuestion, entryLine, exportIds, exportNote, isSelected, noneSelected, routeLabel, selectedEntries, shownHint, toggled,
  usedByApp, type CatalogEntry,
} from './secret-catalog.ts';
import { deleteGroupText, fieldsOf } from './secret-groups.ts';
import { SecretBand } from './SecretRows.tsx';

const MASK = '••••••••';

/** What the form works on for one entry. */
function targetOf(entry: CatalogEntry, secrets: readonly SecretInfo[]): SecretTarget {
  if (entry.type === 'single') return { type: 'single', info: entry.info };
  if (entry.type === 'group') return { type: 'group', group: entry.group, fields: fieldsOf(entry.group, secrets) };
  return { type: 'missing', file: entry.file };
}

export function SecretsPage() {
  const list = useAsync(() => rpc.call('secrets.list'), []);
  const groups = useAsync(() => (can('secrets.groups') ? rpc.call('secrets.groups') : Promise.resolve([] as SecretGroup[])), []);
  const folder = useAsync(async () => (can('secrets.folder') ? rpc.call('secrets.folder') : { missing: [], notices: [] }), []);
  const [editing, setEditing] = useState<CatalogEntry | 'new' | undefined>(undefined);
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<'' | 'export' | 'delete'>('');
  const reload = () => { void list.reload(); void groups.reload(); void folder.reload(); };
  useEffect(() => rpc.on('secrets.changed', reload), [list.reload, groups.reload, folder.reload]);
  const secrets = list.data ?? [];
  const entries = catalogEntries(secrets, groups.data ?? [], folder.data?.missing ?? []);
  const notices = new Map((folder.data?.notices ?? []).map((notice) => [notice.id, notice.text]));
  // shown once all three have answered: rows arriving later would be inserted between the others
  const ready = [list, groups, folder].every((state) => state.data !== undefined || state.error !== null);
  const onPc = can('secrets.delete'); // changing, deleting and exporting a stored secret stays on the PC
  const selected = selectedEntries(entries, deselected);
  const exportable = exportIds(selected);
  const remove = async (entry: CatalogEntry) => {
    const body = usedByApp(entry) ? 'The app itself works with it (an account, a bridge or a calendar) – that stops until a new one is saved.'
      : entry.type === 'missing' ? 'Its file is deleted.' : entry.type === 'group' ? deleteGroupText(fieldsOf(entry.group, secrets).length) : 'Agents using it lose access.';
    if (!(await confirm({ title: `Delete ${entry.name}?`, body, confirmLabel: 'Delete', danger: true }))) return;
    await act(async () => { await rpc.call(entry.type === 'group' ? 'secrets.deleteGroup' : 'secrets.delete', { id: entry.id }); reload(); }, 'Could not delete');
  };
  const exportSelected = async () => {
    if (busy || !exportable.length) return;
    setBusy('export');
    try {
      const result = await act(() => rpc.call('secrets.export', { ids: exportable }), 'Could not export');
      if (result) pushToast(exportNote(result), 15_000);
    } finally { setBusy(''); }
  };
  const removeSelected = async () => {
    if (busy || !selected.length) return;
    if (!(await confirm({ ...deleteQuestion(selected.length), confirmLabel: 'Delete', danger: true }))) return;
    setBusy('delete');
    try {
      const { deleted, failure } = await deleteEntries(selected, (method, id) => rpc.call(method, { id }), errorText);
      if (failure) toastError(new Error(failure), `${deleted} deleted – the others could not be deleted`);
    } finally { setBusy(''); reload(); }
  };
  const actions = onPc && (
    <>
      <button type="button" class="button ghost small" disabled={!entries.length} onClick={() => setDeselected(new Set())}>All</button>
      <button type="button" class="button ghost small" disabled={!entries.length} onClick={() => setDeselected(noneSelected(entries))}>None</button>
      <span class="secret-selected">{selected.length} selected</span>
      <Button variant="ghost" class="small" busy={busy === 'export'} disabled={!exportable.length || busy !== ''} onClick={() => void exportSelected()}>Export</Button>
      <Button variant="ghost" class="small danger" busy={busy === 'delete'} disabled={!selected.length || busy !== ''} onClick={() => void removeSelected()}>Delete</Button>
    </>
  );
  const catalog = (
    <>
      {list.error && <Row label="Unavailable" hint={list.error} />}
      {!ready && <Row class="secret-entry" label="" reserve />}
      {ready && !entries.length && !list.error && <Row label="No secrets stored" reserve />}
      {ready && entries.map((entry, index) => {
        const hint = shownHint(entry, secrets);
        const label = onPc
          ? (
            <label class="secret-pick">
              <input type="checkbox" checked={isSelected(entry, deselected)} aria-label={`Select ${entry.name}`} onChange={() => setDeselected((now) => toggled(now, entry.id))} />
              <span>{entry.name}</span>
            </label>
          )
          : entry.name;
        return [
          index === 0 || entries[index - 1].route !== entry.route
            ? <div key={`route:${entry.route}`} class="secret-route" role="heading" aria-level={4}>
              <span>{routeLabel(entry.route)}</span>
              {notices.has(entry.route) && <span class="secret-route-notice">{notices.get(entry.route)}</span>}
            </div>
            : null,
          <Row key={entry.id} class="secret-entry" label={label} hint={entryLine(entry)} reserve>
            <div class="set-inline">
              {entry.type !== 'missing' && <span class="masked" title={hint} aria-label={hint ? undefined : 'Hidden value'}>{hint ?? MASK}</span>}
              {onPc && can(entry.type === 'group' ? 'secrets.saveGroup' : 'secrets.save') && <button type="button" class="button ghost small" aria-label={`Edit ${entry.name}`} onClick={() => setEditing(entry)}>Edit</button>}
              {onPc && <button type="button" class="button ghost small danger" aria-label={`Delete ${entry.name}`} onClick={() => void remove(entry)}>Delete</button>}
            </div>
          </Row>,
        ];
      })}
    </>
  );
  const form = editing === undefined ? undefined : editing === 'new' ? { key: 'new' } : { key: editing.id, target: targetOf(editing, secrets) };
  return (
    <Group title="Secrets" actions={actions || undefined} hint="Grouped by route. Agents add their own and use each by its handle; values stay encrypted and are never shown.">
      {can('secrets.save')
        ? <SecretBand form={form} onForm={(open) => setEditing(open ? 'new' : undefined)} onSaved={reload}>{catalog}</SecretBand>
        : catalog}
    </Group>
  );
}
