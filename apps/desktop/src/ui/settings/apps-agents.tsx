// AF-005 Settings › Connectors › a connector's "Agents…": which agents may use it – every agent (also the ones hired
// later; no "agents" key) or only those ticked (their ids in its "agents" list in mcp.json / mail.json). The runtime
// offers its tools to those agents only and applies a change at once, without connecting again
// (runtime/apps/agent-access.ts). An entry that names an agent by name (the AI may) shows it ticked.
// Owns: this dialog. Never: changes anything else of the entry.

import { useState } from 'preact/hooks';
import type { ConnectedApp } from '../../shared/model/apps.ts';
import { Dialog, DialogActions } from '../lib/dialog.tsx';
import { errorText } from '../lib/rpc.ts';
import { agents } from '../lib/store.ts';
import { Button } from '../lib/ui.tsx';
import { Segmented, useBusy } from './controls.tsx';
import { agentsPatch, editConnectors, fileOf, namedAgents, patchedEntry } from './apps-files.ts';

type Scope = 'all' | 'some';
const SCOPES: Array<{ value: Scope; label: string }> = [{ value: 'all', label: 'Every agent' }, { value: 'some', label: 'Only these agents' }];

function AgentsForm(props: { app: ConnectedApp; onClose: () => void }) {
  const { app } = props;
  const team = agents.value.filter((agent) => !agent.archivedAt).sort((a, b) => a.name.localeCompare(b.name));
  const [scope, setScope] = useState<Scope>(app.agents ? 'some' : 'all');
  const [picked, setPicked] = useState<Set<string>>(() => namedAgents(app.agents, team));
  const [error, setError] = useState('');
  const [busy, run] = useBusy();
  const toggle = (id: string, on: boolean) => { const next = new Set(picked); if (on) next.add(id); else next.delete(id); setPicked(next); };
  const save = () => void run(async () => {
    setError('');
    try {
      const ids = scope === 'all' ? undefined : team.filter((agent) => picked.has(agent.id)).map((agent) => agent.id);
      await editConnectors(fileOf(app), (text) => patchedEntry(fileOf(app), text, app.name, agentsPatch(ids)));
      props.onClose();
    } catch (failure) { setError(errorText(failure)); }
  });
  const none = scope === 'some' && !team.some((agent) => picked.has(agent.id));
  return (
    <>
      <Segmented label="Who may use it" value={scope} options={SCOPES} onChange={setScope} />
      <div class={`apps-agents${scope === 'all' ? ' inactive' : ''}`} role="group" aria-label="Agents">
        {team.map((agent) => (
          <label key={agent.id} class="apps-agent">
            <input type="checkbox" checked={scope === 'all' || picked.has(agent.id)} disabled={scope === 'all'} onChange={(event) => toggle(agent.id, (event.currentTarget as HTMLInputElement).checked)} />
            <span class="apps-agent-name">{agent.name}</span>
            <span class="apps-agent-role">{agent.role}</span>
          </label>
        ))}
        {!team.length && <p class="secret-field-hint">No agents yet.</p>}
      </div>
      <DialogActions message={error || (none ? 'No agent ticked: its tools reach nobody' : scope === 'all' ? 'Also the agents hired later' : 'Its tools reach only these agents')} tone={error ? 'error' : 'muted'}>
        <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} onClick={save}>Save</Button>
      </DialogActions>
    </>
  );
}

export function AgentsDialog(props: { app: ConnectedApp | null; onClose: () => void }) {
  const { app } = props;
  return (
    <Dialog open={app !== null} onClose={props.onClose} title={app ? `Who may use ${app.name}` : undefined} width={480} class="secret-edit anchored">
      {app && <AgentsForm key={app.id} app={app} onClose={props.onClose} />}
    </Dialog>
  );
}
