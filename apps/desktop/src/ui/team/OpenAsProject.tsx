// AF-018: "Open as project" – adds an agent's folder as a project (projects.add; the same project again when it is
// one already) and opens its page in the Projects tab. On the agent page's Access section (the agent's project folder)
// and after "Agent from folder" created an agent. Owner only; a busy click keeps the button's box.
// Owns: this button. Never: changes the agent or its folder.

import { useState } from 'preact/hooks';
import { isOwner } from '../lib/session.ts';
import { addAndOpenProject } from '../lib/projects.ts';
import { toastError } from '../lib/toasts.ts';

export function OpenAsProject(props: { folder: string; class?: string; label?: string; onOpened?: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!isOwner() || !props.folder) return null;
  const open = async () => {
    if (busy) return;
    setBusy(true);
    try { await addAndOpenProject(props.folder); props.onOpened?.(); } catch (error) { toastError(error, 'Could not open the project'); } finally { setBusy(false); }
  };
  return (
    <button type="button" class={props.class ?? 'text-button'} disabled={busy} title={props.folder} onClick={() => void open()}>
      {props.label ?? 'Open as project'}
    </button>
  );
}
