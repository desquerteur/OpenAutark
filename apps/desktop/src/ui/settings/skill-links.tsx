// Settings › Skills (AF-007): "Add from link" – paste a GitHub repository or folder, a SKILL.md or a ZIP address (or choose
// a ZIP), see what it holds (name, description, files, a warning for scripts; several skills to choose from), pick the place
// (shared, an agent's own, an agent's home project) and install – and "From links": the skills installed that way with
// Update, which reads the source again and shows what changes before anything is replaced.
// Owns: these two dialogs and that group. Never: decides what is safe or where a skill goes (runtime/skills/links/).

import { useEffect, useState } from 'preact/hooks';
import '../../shared/api/methods-skill-links.ts'; // the skills.*Link method shapes (module augmentation)
import type { FileRef } from '../../shared/model/system.ts';
import type { LinkedSkill, SkillLinkCandidate, SkillLinkPreview, SkillLinkTarget, SkillUpdatePreview } from '../../shared/model/skill-links.ts';
import { Dialog, DialogActions } from '../lib/dialog.tsx';
import { uploadRef } from '../lib/files.ts';
import { listTime } from '../lib/format.ts';
import { bridge } from '../lib/platform.ts';
import { errorText, rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { toastError } from '../lib/toasts.ts';
import { Button } from '../lib/ui.tsx';
import { skillTitle } from '../team/agent-core-model.ts';
import { ActionButton, Group, Row, Select, useAsync } from './controls.tsx';
import { changeText, filesLine, firstChoice, scriptWarning, sourceText, targetKey, targetOf, updateSummary } from './skill-links-model.ts';

/** A ZIP (or SKILL.md) the person chooses, uploaded into the runtime's file store; undefined when cancelled. */
async function chooseFile(): Promise<FileRef | undefined> {
  if (bridge) return (await bridge.files.pick('files'))[0];
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,.md,application/zip';
    input.addEventListener('cancel', () => resolve(undefined));
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) { resolve(undefined); return; }
      uploadRef(file).then(resolve, reject);
    });
    input.click();
  });
}

function FileList(props: { skill: Pick<SkillLinkCandidate, 'files' | 'size'> }) {
  return (
    <details class="skill-link-files">
      <summary>{filesLine(props.skill)}</summary>
      <ul>{props.skill.files.map((file) => <li key={file.path}><span>{file.path}</span>{file.script && <span class="skill-link-tag">script</span>}</li>)}</ul>
    </details>
  );
}

function SkillCard(props: { skill: SkillLinkCandidate; choosable: boolean; chosen: boolean; onToggle: () => void }) {
  const { skill } = props;
  const warning = scriptWarning(skill.scripts);
  return (
    <div class={`skill-link-skill${props.chosen ? ' chosen' : ''}`}>
      <label class="skill-link-head">
        {props.choosable && <input type="checkbox" checked={props.chosen} onChange={props.onToggle} aria-label={`Install ${skill.name}`} />}
        <span class="skill-link-name">{skillTitle(skill.name)}</span>
        {skill.route && <span class="skill-link-route">{skill.route}</span>}
      </label>
      <p class="skill-link-description">{skill.description}</p>
      <FileList skill={skill} />
      {warning && <p class="skill-link-warn" role="note">{warning}</p>}
      {skill.notes.length > 0 && <p class="skill-link-notes">{skill.notes.join(' · ')}</p>}
    </div>
  );
}

function LinkForm(props: { onClose: () => void; onInstalled: () => void }) {
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<SkillLinkPreview>();
  const [targets, setTargets] = useState<SkillLinkTarget[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [place, setPlace] = useState('shared');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try { await work(); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  const show = async (read: Promise<SkillLinkPreview>) => {
    const [found, places] = await Promise.all([read, rpc.call('skills.linkTargets')]);
    setPreview(found);
    setTargets(places);
    setChosen(firstChoice(found.skills));
    if (!places.some((entry) => targetKey(entry.target) === place)) setPlace('shared');
  };
  const readLink = () => void run(() => show(rpc.call('skills.previewLink', { url: url.trim() })));
  const readFile = () => void run(async () => {
    const file = await chooseFile();
    if (file) await show(rpc.call('skills.previewLink', { fileId: file.id }));
  });
  const install = () => void run(async () => {
    const target = targetOf(place, targets);
    if (!preview || !target) return;
    await rpc.call('skills.installLink', { previewId: preview.id, routes: chosen, target });
    props.onInstalled();
    props.onClose();
  });
  if (!preview) {
    return (
      <>
        <label class="field-label" for="skill-link-url">Link</label>
        <input id="skill-link-url" class="input" type="url" autocomplete="off" spellcheck={false} maxLength={2048} value={url}
          placeholder="https://github.com/anthropics/skills/tree/main/skills/pdf"
          onInput={(event) => setUrl((event.currentTarget as HTMLInputElement).value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && url.trim() && !busy) readLink(); }} />
        <p class="skill-link-help">A GitHub repository or a folder with a SKILL.md, the address of a SKILL.md, or of a ZIP. Nothing is installed before you see what it holds.</p>
        <DialogActions message={error} tone="error">
          {can('files.upload') && <Button variant="secondary" disabled={busy} onClick={readFile}>Choose ZIP…</Button>}
          <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!url.trim()} onClick={readLink}>Show</Button>
        </DialogActions>
      </>
    );
  }
  const several = preview.skills.length > 1;
  const toggle = (route: string) => setChosen((now) => (now.includes(route) ? now.filter((entry) => entry !== route) : [...now, route]));
  const options = targets.map((entry) => ({ value: targetKey(entry.target), label: entry.label, hint: entry.hint }));
  const blocked = !preview.skills.length ? 'Nothing here can be installed' : !chosen.length ? 'Choose the skills to install' : '';
  return (
    <>
      <p class="skill-link-source" title={preview.source.url}>{sourceText(preview.source)}</p>
      {several && <p class="skill-link-help">{preview.skills.length} skills{preview.truncated ? ' (and maybe more)' : ''} – choose the ones to install.</p>}
      <div class="skill-link-list">
        {preview.skills.map((skill) => <SkillCard key={skill.route} skill={skill} choosable={several} chosen={chosen.includes(skill.route)} onToggle={() => toggle(skill.route)} />)}
      </div>
      {preview.problems.length > 0 && (
        <p class="skill-link-notes">Not installable: {preview.problems.map((problem) => `${problem.route || 'the root'} (${problem.problem})`).join(' · ')}</p>
      )}
      <label class="field-label" for="skill-link-place">Install for</label>
      <Select label="Install for" value={place} options={options} onChange={setPlace} />
      <DialogActions message={error || blocked} tone={error ? 'error' : 'muted'}>
        <Button variant="secondary" disabled={busy} onClick={() => { setPreview(undefined); setError(''); }}>Back</Button>
        <Button variant="primary" busy={busy} disabled={Boolean(blocked)} onClick={install}>{chosen.length > 1 ? `Install ${chosen.length}` : 'Install'}</Button>
      </DialogActions>
    </>
  );
}

/** The Skills group's head action "Add from link" and its dialog. */
export function AddFromLink(props: { onInstalled: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" class="button ghost small" aria-haspopup="dialog" onClick={() => setOpen(true)}>Add from link</button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Add skill from link" width={600} class="secret-edit anchored skill-link">
        {open && <LinkForm onClose={() => setOpen(false)} onInstalled={props.onInstalled} />}
      </Dialog>
    </>
  );
}

function UpdateForm(props: { check: SkillUpdatePreview; onClose: () => void; onApplied: () => void }) {
  const { check } = props;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const warning = scriptWarning(check.scripts);
  const apply = async () => {
    setBusy(true);
    setError('');
    try {
      await rpc.call('skills.applyUpdate', { previewId: check.id });
      props.onApplied();
      props.onClose();
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  return (
    <>
      <p class="skill-link-source" title={check.source.url}>{sourceText(check.source)}</p>
      <p class="skill-link-help">{updateSummary(check.changes, check.unchanged)}</p>
      {check.description && <p class="skill-link-description">Description: {check.description.after}</p>}
      {check.changes.length > 0 && <ul class="skill-link-changes">{check.changes.map((change) => <li key={change.path} class={change.local ? 'local' : undefined}>{changeText(change)}</li>)}</ul>}
      {warning && <p class="skill-link-warn" role="note">{warning}</p>}
      <DialogActions message={error} tone="error">
        <Button variant="secondary" onClick={props.onClose}>{check.changes.length ? 'Cancel' : 'Close'}</Button>
        {check.changes.length > 0 && <Button variant="primary" busy={busy} onClick={() => void apply()}>Update</Button>}
      </DialogActions>
    </>
  );
}

function LinkedRow(props: { skill: LinkedSkill; onCheck: (skill: LinkedSkill) => Promise<void> }) {
  const { skill } = props;
  const [busy, setBusy] = useState(false);
  const hint = `${skill.place} · ${sourceText(skill.source)} · ${skill.updatedAt > skill.installedAt ? 'updated' : 'installed'} ${listTime(skill.updatedAt)}`;
  const check = async () => { setBusy(true); try { await props.onCheck(skill); } finally { setBusy(false); } };
  return (
    <Row label={skillTitle(skill.name)} hint={hint} reserve>
      <ActionButton label="Update" busy={busy} onClick={() => void check()} />
    </Row>
  );
}

/** "From links": every skill installed from a link with Update (absent while there is none). */
export function LinkedSkills(props: { version: number; onChanged: () => void }) {
  const list = useAsync(() => rpc.call('skills.linked'), [props.version]);
  const [check, setCheck] = useState<SkillUpdatePreview>();
  useEffect(() => rpc.on('skills.changed', () => void list.reload()), [list.reload]);
  const open = async (skill: LinkedSkill) => {
    try {
      let fileId: string | undefined;
      if (skill.source.kind === 'upload') {
        const file = await chooseFile();
        if (!file) return;
        fileId = file.id;
      }
      setCheck(await rpc.call('skills.checkUpdate', { path: skill.path, ...(fileId ? { fileId } : {}) }));
    } catch (failure) { toastError(new Error(errorText(failure)), `Could not check ${skillTitle(skill.name)}`); }
  };
  const skills = list.data ?? [];
  if (!skills.length) return null;
  return (
    <Group title="From links" id="settings-skill-links" hint="Skills installed from a link. Update reads the source again and shows what changes first.">
      {skills.map((skill) => <LinkedRow key={skill.path} skill={skill} onCheck={open} />)}
      <Dialog open={Boolean(check)} onClose={() => setCheck(undefined)} title={check ? `Update ${skillTitle(check.name)}` : 'Update'} width={560} class="secret-edit anchored skill-link">
        {check && <UpdateForm check={check} onClose={() => setCheck(undefined)} onApplied={() => { props.onChanged(); void list.reload(); }} />}
      </Dialog>
    </Group>
  );
}
