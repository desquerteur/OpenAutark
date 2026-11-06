// Team › Add › Agent: a role and, if wanted, a name; agents.create, then the new agent's page opens. The
// runtime proposes a distinct name when none is given. Who it reports to, its space and everything else is
// set by the manager or by asking the AI (agents.update).
// Owns: the hire dialog. Never: invents names or roles itself.

import { useEffect, useRef, useState } from 'preact/hooks';
import { Button, Dialog } from '../lib/ui.tsx';
import { agents, upsertById } from '../lib/store.ts';
import { rpc } from '../lib/rpc.ts';
import { go } from '../lib/router.ts';
import { toastError } from '../lib/toasts.ts';

export function NewAgentDialog(props: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const roleField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!props.open) return;
    setName(''); setRole('');
    requestAnimationFrame(() => roleField.current?.focus({ preventScroll: true }));
  }, [props.open]);

  const canCreate = !busy && role.trim().length > 0;
  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    try {
      const agent = await rpc.call('agents.create', { role: role.trim(), ...(name.trim() ? { name: name.trim() } : {}) });
      upsertById(agents, agent);
      props.onClose();
      go.agent(agent.id);
    } catch (err) {
      toastError(err, 'Agent could not be created');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onClose={props.onClose} title="New agent" width={440} class="new-agent">
      <label class="field-label" for="new-agent-role">Role</label>
      <input ref={roleField} id="new-agent-role" class="input" type="text" value={role} maxLength={80} required
        onInput={(event) => setRole((event.currentTarget as HTMLInputElement).value)} />
      <label class="field-label" for="new-agent-name">Name</label>
      <input id="new-agent-name" class="input" type="text" value={name} maxLength={80} placeholder="Optional"
        onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)}
        onKeyDown={(event) => { if (event.key === 'Enter') void create(); }} />
      <div class="dialog-actions">
        <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={!canCreate} onClick={() => void create()}>Create</Button>
      </div>
    </Dialog>
  );
}
