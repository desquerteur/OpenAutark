// Settings › Skills & memory, beside the lists: "New skill" (a name and what it is for; skills.save writes <workspace>/skills/<name>/
// SKILL.md, then it opens in the file tab, where the person or the AI writes the rest) and the modes (modes.list): every mode
// with where it comes from and what it is for; a mode of the person or an agent is a file <data>/modes/<key>.md and opens in the
// file tab, right click deletes it (a built-in of the same key comes back). Agents choose their mode themselves.
// Owns: this group and that dialog. Never: edits a mode's text or a built-in mode.

import { useState } from 'preact/hooks';
import { Dialog, DialogActions } from '../lib/dialog.tsx';
import { confirm } from '../lib/ui.tsx';
import { useContextMenu } from '../lib/context-menu.tsx';
import { errorText, rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { Button } from '../lib/ui.tsx';
import type { ModeInfo } from '../../shared/model/knowledge.ts';
import { openFileTab } from '../workspace/file-tabs.ts';
import { act, Group, Row, useAsync, useBusy } from './controls.tsx';
import { joined, openInTab } from './open-file.ts';

/** A skill's name as its folder takes it: lower-case letters, digits and hyphens (pure). */
export const skillFolderName = (typed: string): string => typed.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

const valueOf = (event: Event) => (event.currentTarget as HTMLInputElement).value;

function NewSkillForm(props: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const [error, setError] = useState('');
  const [busy, run] = useBusy();
  const folder = skillFolderName(name);
  const blocked = !folder ? 'Enter a name' : !about.trim() ? 'Say what it is for and when to read it' : '';
  const save = () => void run(async () => {
    setError('');
    try {
      // skills.save writes over a skill of this name; asked fresh, the AI may have added one since the page opened
      if ((await rpc.call('skills.list', { every: true })).some((skill) => skill.name === folder)) { setError(`A skill named ${folder} exists already. Another name keeps it as it is.`); return; }
      const skill = await rpc.call('skills.save', { name: folder, description: about.trim(), body: `# ${name.trim()}\n` });
      openFileTab(joined(skill.path, 'SKILL.md'));
      props.onCreated();
      props.onClose();
    } catch (failure) { setError(errorText(failure)); }
  });
  return (
    <>
      <label class="field-label" for="skill-name">Name</label>
      <input id="skill-name" class="input" maxLength={64} autocomplete="off" value={name} onInput={(event) => setName(valueOf(event))} />
      <label class="field-label" for="skill-about">What it is for and when to read it</label>
      <input id="skill-about" class="input" maxLength={1024} autocomplete="off" value={about} onInput={(event) => setAbout(valueOf(event))} />
      <DialogActions message={error || blocked} tone={error ? 'error' : 'muted'}>
        <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={Boolean(blocked)} onClick={save}>Create</Button>
      </DialogActions>
    </>
  );
}

/** The head action of Skills and its dialog. */
export function NewSkill(props: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" class="button ghost small" aria-haspopup="dialog" onClick={() => setOpen(true)}>New skill</button>
      <Dialog open={open} onClose={() => setOpen(false)} title="New skill" width={520} class="secret-edit anchored">
        {open && <NewSkillForm onClose={() => setOpen(false)} onCreated={props.onCreated} />}
      </Dialog>
    </>
  );
}

const modeLine = (mode: ModeInfo): string => [mode.source === 'user' ? (mode.overrides ? 'Yours, in place of the built-in one' : 'Yours') : 'Built-in', mode.description].filter(Boolean).join(' · ');

function ModeRow(props: { mode: ModeInfo; root: string; onChanged: () => void }) {
  const { mode } = props;
  const file = joined(props.root, `modes/${mode.key}.md`);
  const remove = async () => {
    const body = mode.overrides ? 'The built-in mode of this name comes back.' : 'Its file is deleted.';
    if (await confirm({ title: `Delete ${mode.name}?`, body, confirmLabel: 'Delete', danger: true })) await act(async () => { await rpc.call('modes.delete', { key: mode.key }); props.onChanged(); }, 'Could not delete');
  };
  const context = useContextMenu(() => [{ items: [{ label: 'Delete', danger: true, onSelect: () => void remove() }] }]);
  if (mode.source !== 'user' || !props.root) return <Row label={mode.name} hint={modeLine(mode)} reserve />;
  return (
    <button type="button" class="set-row reserve file-open-row" title={file} {...context} onClick={() => openFileTab(file)}>
      <div class="set-row-text">
        <div class="set-row-label">{mode.name}</div>
        <div class="set-row-hint reserved">{modeLine(mode)}</div>
      </div>
    </button>
  );
}

export function ModesGroup() {
  const open = can('files.readPath');
  const list = useAsync(() => rpc.call('modes.list'), []);
  const root = useAsync(() => (open ? rpc.call('system.root').then((info) => info.path) : Promise.resolve('')), [open]);
  const modes = [...(list.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Group title="Modes" id="settings-modes" actions={open ? <button type="button" class="button ghost small" onClick={() => void openInTab('modes')}>Open folder</button> : undefined}>
      {list.error && <Row label="Unavailable" hint={list.error} reserve />}
      {modes.map((mode) => <ModeRow key={mode.key} mode={mode} root={root.data ?? ''} onChanged={() => void list.reload()} />)}
    </Group>
  );
}
