// Agent editor, opened by "Edit" on the agent page: avatar (AvatarPicker.tsx), name, role and instructions.
// The instructions are the agent's SYSTEM.md (the runtime writes the file). Save sends one agents.update with
// only the changed fields (editor-model.ts); the runtime validates again. Everything else (whom it reports to,
// space, team, mode, PC, voice) is set by the manager or by asking the AI.
// Owns: the editor form. Never: changes the model or schedules (own sections).

import type { ComponentChildren } from 'preact';
import { useId, useState } from 'preact/hooks';
import type { ParamsOf } from '../../shared/api/methods.ts';
import type { Agent } from '../../shared/model/org.ts';
import { Button } from '../lib/ui.tsx';
import { agents, upsertById } from '../lib/store.ts';
import { rpc } from '../lib/rpc.ts';
import { toastError } from '../lib/toasts.ts';
import { AvatarPicker } from './AvatarPicker.tsx';
import { draftOf, editorPatch, hasChanges } from './editor-model.ts';
import type { EditorDraft } from './editor-model.ts';

function Field(props: { id: string; label: string; hint?: string; children: ComponentChildren }) {
  return (
    <div class="agent-field">
      <label class="field-label" for={props.id}>{props.label}</label>
      {props.children}
      {props.hint && <small class="agent-field-hint">{props.hint}</small>}
    </div>
  );
}

const text = (event: Event) => (event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value;

export function AgentEditor(props: { agent: Agent; onDone: () => void }) {
  const { agent } = props;
  const [draft, setDraft] = useState<EditorDraft>(() => draftOf(agent));
  const [busy, setBusy] = useState(false);
  const ids = useId();
  const set = <K extends keyof EditorDraft>(key: K, value: EditorDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const patch = editorPatch(agent, draft);
  const valid = draft.name.trim().length > 0;

  const save = async () => {
    if (!valid || busy) return;
    if (!hasChanges(patch)) { props.onDone(); return; }
    setBusy(true);
    try {
      upsertById(agents, await rpc.call('agents.update', { id: agent.id, patch: patch as ParamsOf<'agents.update'>['patch'] }));
      props.onDone();
    } catch (error) {
      toastError(error, 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="agent-editor" aria-label={`Edit ${agent.name}`} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <AvatarPicker agentId={agent.id} name={draft.name} value={draft.avatar} onChange={(avatar) => set('avatar', avatar)} />
      <div class="agent-editor-grid">
        <Field id={`${ids}-name`} label="Name">
          <input id={`${ids}-name`} class="input" type="text" value={draft.name} maxLength={80} required onInput={(event) => set('name', text(event))} />
        </Field>
        <Field id={`${ids}-role`} label="Role">
          <input id={`${ids}-role`} class="input" type="text" value={draft.role} maxLength={80} onInput={(event) => set('role', text(event))} />
        </Field>
      </div>
      <Field id={`${ids}-instructions`} label="Instructions" hint="Saved in SYSTEM.md in its agent folder.">
        <textarea id={`${ids}-instructions`} class="input agent-instructions-input" rows={8} value={draft.instructions} maxLength={20_000}
          onInput={(event) => set('instructions', text(event))} />
      </Field>
      <div class="agent-editor-actions">
        <Button variant="ghost" onClick={props.onDone}>Cancel</Button>
        <Button variant="primary" type="submit" busy={busy} disabled={!valid || !hasChanges(patch)}>Save</Button>
      </div>
    </form>
  );
}
