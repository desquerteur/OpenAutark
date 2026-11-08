// AF-013: the agent page's Access section – the agent's own mode (a chat can override it in the composer's mode cell)
// and its fine rules: folders it may also change or must never touch, commands that run without asking or never,
// tools and connectors allowed or forbidden, the network and spending money. The rules dialog writes them whole
// (access.set); "Always for this agent" in the approval dialog adds to them. Only the person on the PC changes them.
// AF-018: the folder it works in as its own row (Project: the folder's name) with "Open as project" (OpenAsProject.tsx).
// Owns: this section and its dialog. Never: judges (the runtime does).

import { useEffect, useState } from 'preact/hooks';
import type { Agent } from '../../shared/model/org.ts';
import { ACCESS_MODE_LABELS, ACCESS_MODES, type AccessChoice, type AccessMode, type AccessRules } from '../../shared/model/access.ts';
import { accessFor, setAgentAccess } from '../lib/access.ts';
import { Dialog, DialogActions } from '../lib/dialog.tsx';
import { Select, type SelectOption } from '../lib/ui.tsx';
import { isOwner } from '../lib/session.ts';
import { errorText } from '../lib/rpc.ts';
import { toastError } from '../lib/toasts.ts';
import { folderName } from '../lib/projects.ts';
import { OpenAsProject } from './OpenAsProject.tsx'; // AF-018

const MODE_OPTIONS: Array<SelectOption<AccessMode>> = ACCESS_MODES.map((mode) => ({ value: mode, label: ACCESS_MODE_LABELS[mode].label, hint: ACCESS_MODE_LABELS[mode].description }));
type ChoiceValue = AccessChoice | '';
const NETWORK_OPTIONS: Array<SelectOption<ChoiceValue>> = [{ value: '', label: 'Allowed' }, { value: 'ask', label: 'Ask first' }, { value: 'deny', label: 'Never' }];
const MONEY_OPTIONS: Array<SelectOption<ChoiceValue>> = [{ value: '', label: 'As the mode says' }, { value: 'allow', label: 'Allowed' }, { value: 'ask', label: 'Ask first' }, { value: 'deny', label: 'Never' }];

const lines = (value: string): string[] | undefined => {
  const out = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return out.length ? out : undefined;
};
const joined = (list: readonly string[] | undefined): string => (list ?? []).join('\n');

/** How many rules there are, for the row's hint. */
export function rulesCount(rules: AccessRules): number {
  return (rules.folders?.write?.length ?? 0) + (rules.folders?.deny?.length ?? 0) + (rules.commands?.allow?.length ?? 0) + (rules.commands?.deny?.length ?? 0)
    + (rules.tools?.allow?.length ?? 0) + (rules.tools?.deny?.length ?? 0) + (rules.network ? 1 : 0) + (rules.money ? 1 : 0);
}

/** The dialog's fields back into rules (empty parts dropped). */
export function rulesFrom(form: Record<string, string>): AccessRules {
  const rules: AccessRules = {};
  const pair = <K extends string>(a: K, b: K, x?: string[], y?: string[]) => (x || y ? { ...(x ? { [a]: x } : {}), ...(y ? { [b]: y } : {}) } as Partial<Record<K, string[]>> : undefined);
  const folders = pair('write', 'deny', lines(form.write ?? ''), lines(form.denyFolders ?? ''));
  if (folders) rules.folders = folders;
  const commands = pair('allow', 'deny', lines(form.allowCommands ?? ''), lines(form.denyCommands ?? ''));
  if (commands) rules.commands = commands;
  const tools = pair('allow', 'deny', lines(form.allowTools ?? ''), lines(form.denyTools ?? ''));
  if (tools) rules.tools = tools;
  if (form.network) rules.network = form.network as AccessChoice;
  if (form.money) rules.money = form.money as AccessChoice;
  return rules;
}

function formOf(rules: AccessRules): Record<string, string> {
  return {
    write: joined(rules.folders?.write), denyFolders: joined(rules.folders?.deny), allowCommands: joined(rules.commands?.allow), denyCommands: joined(rules.commands?.deny),
    allowTools: joined(rules.tools?.allow), denyTools: joined(rules.tools?.deny), network: rules.network ?? '', money: rules.money ?? '',
  };
}

const FIELDS: ReadonlyArray<{ key: string; label: string; hint: string }> = [
  { key: 'write', label: 'May also change these folders', hint: 'One absolute folder per line.' },
  { key: 'denyFolders', label: 'Never touch these folders', hint: 'Not read, not changed – one per line.' },
  { key: 'allowCommands', label: 'Commands that run without asking', hint: 'Patterns, one per line: npm test, git *' },
  { key: 'denyCommands', label: 'Commands that never run', hint: 'Patterns, one per line: rm -rf *, git push *' },
  { key: 'allowTools', label: 'Connectors and tools that run without asking', hint: 'Tool names, * allowed: app.github.*' },
  { key: 'denyTools', label: 'Connectors and tools that never run', hint: 'Tool names, * allowed: app.mail.send*' },
];

function RulesDialog(props: { agent: Agent; rules: AccessRules; onClose: () => void }) {
  const [form, setForm] = useState(() => formOf(props.rules));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key: string, value: string) => setForm({ ...form, [key]: value });
  const save = async () => {
    setBusy(true);
    try { await setAgentAccess(props.agent.id, { rules: rulesFrom(form) }); props.onClose(); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={props.onClose} title={`Access rules of ${props.agent.name}`} width={560} class="anchored access-rules">
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <p class="dialog-text">Forbidden beats allowed, allowed beats the mode.</p>
        {FIELDS.map((field) => (
          <label key={field.key} class="access-rules-field">
            <span class="access-rules-label">{field.label}</span>
            <textarea class="input access-rules-text" rows={2} value={form[field.key]} spellcheck={false} placeholder={field.hint}
              onInput={(event) => set(field.key, (event.currentTarget as HTMLTextAreaElement).value)} />
          </label>
        ))}
        <div class="access-rules-choices">
          <label class="access-rules-field"><span class="access-rules-label">Network</span>
            <Select native label="Network" value={(form.network ?? '') as ChoiceValue} options={NETWORK_OPTIONS} onChange={(value) => set('network', value)} /></label>
          <label class="access-rules-field"><span class="access-rules-label">Spending money</span>
            <Select native label="Spending money" value={(form.money ?? '') as ChoiceValue} options={MONEY_OPTIONS} onChange={(value) => set('money', value)} /></label>
        </div>
        <DialogActions message={error}>
          <button type="button" class="button secondary" onClick={props.onClose}>Cancel</button>
          <button type="button" class="button primary" disabled={busy} onClick={() => void save()}>Save</button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function AccessSection(props: { agent: Agent }) {
  const { agent } = props;
  const access = accessFor(agent.id).value;
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<AccessMode | null>(null);
  useEffect(() => { setMode(access?.agentMode ?? null); }, [access?.agentMode]);
  if (!access || mode === null) return null;
  const owner = isOwner() && agent.archivedAt === undefined;
  const count = rulesCount(access.rules);
  const save = async (next: AccessMode) => {
    const before = mode;
    setMode(next);
    try { await setAgentAccess(agent.id, { mode: next }); } catch (error) { setMode(before); toastError(error, 'Could not save the access mode'); }
  };
  return (
    <section class="agent-section" aria-label="Access">
      <div class="agent-section-head"><h3 class="agent-section-title">Access</h3></div>
      <div class="agent-row">
        <span class="agent-row-text"><span class="agent-row-label">Mode</span><small class="agent-row-hint">{ACCESS_MODE_LABELS[mode].description}</small></span>
        <Select label="Access mode" value={mode} options={MODE_OPTIONS} disabled={!owner} onChange={(next) => void save(next)} />
      </div>
      {access.project && isOwner() && (
        <div class="agent-row">{/* AF-018: the folder it works in, as a project */}
          <span class="agent-row-text"><span class="agent-row-label">Project</span><small class="agent-row-hint" title={access.project}>{folderName(access.project)}</small></span>
          <OpenAsProject folder={access.project} />
        </div>
      )}
      <div class="agent-row">
        <span class="agent-row-text"><span class="agent-row-label">Rules</span><small class="agent-row-hint">{count ? `${count} rule${count === 1 ? '' : 's'}` : 'None – the mode decides'}</small></span>
        {owner && <button type="button" class="text-button" onClick={() => setEditing(true)}>Edit</button>}
      </div>
      {editing && <RulesDialog agent={agent} rules={access.rules} onClose={() => setEditing(false)} />}
    </section>
  );
}
