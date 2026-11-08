// AF-014: the "Agent from folder" dialog – the folder (typed, chosen with Choose…, or dropped on the dialog), what it
// suggests (name and role from its README / package.json …) and what the agent will follow and see there (instruction
// files, skills, other tools' settings, agents already working in it – several per folder are fine), the access mode it
// starts in (Auto in project folder) and Create. AF-018: after Create the dialog says the agent is ready and offers
// "Open as project" (the folder on the Projects tab, OpenAsProject.tsx) or "Open agent page". Mounted once by the shell.
// Owns: the dialog. Never: reads folders itself (folderAgents.find) or creates agents without the person's click.

import { useEffect, useState } from 'preact/hooks';
import '../../shared/api/methods-folder-agents.ts';
import type { FolderFinding } from '../../shared/model/folder-agent.ts';
import { ACCESS_MODE_LABELS, ACCESS_MODES, FOLDER_AGENT_MODE, type AccessMode } from '../../shared/model/access.ts';
import { Dialog, DialogActions } from '../lib/dialog.tsx';
import { Select, type SelectOption } from '../lib/ui.tsx';
import { bridge } from '../lib/platform.ts';
import { errorText, rpc } from '../lib/rpc.ts';
import { isOwner } from '../lib/session.ts';
import { navigate } from '../lib/router.ts';
import { droppedFolder, folderAgentRequest, mayHoldFolder } from './folder-agent.ts';
import { folderName } from '../lib/projects.ts';
import { OpenAsProject } from './OpenAsProject.tsx'; // AF-018

const MODE_OPTIONS: Array<SelectOption<AccessMode>> = ACCESS_MODES.map((mode) => ({ value: mode, label: ACCESS_MODE_LABELS[mode].label, hint: ACCESS_MODE_LABELS[mode].description }));

function Found(props: { title: string; items: string[]; empty: string }) {
  return (
    <div class="folder-agent-found">
      <span class="folder-agent-found-title">{props.title}</span>
      {props.items.length ? <span class="folder-agent-found-items">{props.items.join(' · ')}</span> : <span class="folder-agent-found-none">{props.empty}</span>}
    </div>
  );
}

/** Windows: the Explorer's right-click entry "Create Autark agent from this folder" – its state, remove or add it (this user only). */
function ExplorerLine() {
  const menu = bridge?.explorerMenu;
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { void menu?.('state').then(setOn).catch(() => setOn(null)); }, []);
  if (!menu || on === null) return null;
  const flip = () => { void menu(on ? 'off' : 'on').then(setOn).catch(() => undefined); };
  return (
    <p class="folder-agent-explorer">
      Explorer right-click “Create Autark agent from this folder”: {on ? 'on' : 'off'} ·{' '}
      <button type="button" class="access-request-link" onClick={flip}>{on ? 'Remove from Explorer' : 'Add to Explorer'}</button>
    </p>
  );
}

function FolderAgentForm(props: { start?: string; onClose: () => void }) {
  const [folder, setFolder] = useState(props.start ?? '');
  const [finding, setFinding] = useState<FolderFinding | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [mode, setMode] = useState<AccessMode>(FOLDER_AGENT_MODE);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [created, setCreated] = useState<{ agentId: string; name: string; folder: string } | null>(null); // AF-018

  const look = async (path: string) => {
    setFolder(path);
    setFinding(null);
    if (!path.trim()) { setMessage(''); return; }
    try {
      const found = await rpc.call('folderAgents.find', { folder: path.trim() });
      setFinding(found); setName(found.name); setRole(found.role); setMessage('');
    } catch (error) { setMessage(errorText(error)); }
  };
  useEffect(() => { if (props.start) void look(props.start); }, [props.start]);

  const choose = async () => {
    const picked = await bridge?.files.pickFolder?.('agent').catch(() => null);
    if (picked) void look(picked);
  };
  const create = async () => {
    if (!finding || busy) return;
    setBusy(true);
    try {
      const made = await rpc.call('folderAgents.create', { folder: finding.folder, name: name.trim(), role: role.trim(), mode });
      setCreated({ agentId: made.agent.id, name: made.agent.name, folder: finding.folder });
    } catch (error) { setMessage(errorText(error)); } finally { setBusy(false); }
  };

  if (created) { // AF-018: the agent is there – open its folder as a project or the agent's page
    const openAgent = () => { props.onClose(); navigate({ view: 'team', agentId: created.agentId }); };
    return (
      <div class="folder-agent">
        <p class="dialog-text">{created.name} is ready and works in {folderName(created.folder)}. Open the folder as a project to start sessions there.</p>
        <DialogActions>
          <button type="button" class="button secondary" onClick={openAgent}>Open agent page</button>
          <OpenAsProject folder={created.folder} class="button primary" onOpened={props.onClose} />
        </DialogActions>
      </div>
    );
  }

  return (
    <form class={`folder-agent${over ? ' drag-over' : ''}`} onSubmit={(event) => { event.preventDefault(); void create(); }}
      onDragOver={(event) => { if (mayHoldFolder(event.dataTransfer)) { event.preventDefault(); event.stopPropagation(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => { setOver(false); const dropped = droppedFolder(event.dataTransfer); if (dropped) { event.preventDefault(); event.stopPropagation(); void look(dropped); } }}>
      <p class="dialog-text">The agent works in this folder (your project): it starts its work there, follows the folder's instruction files and sees its skills.</p>
      <label class="folder-agent-field">
        <span class="folder-agent-label">Folder</span>
        <span class="folder-agent-row">
          <input class="input" value={folder} placeholder="Drop a folder here or choose one" spellcheck={false} aria-label="Folder"
            onInput={(event) => setFolder((event.currentTarget as HTMLInputElement).value)}
            onChange={(event) => void look((event.currentTarget as HTMLInputElement).value)} />
          {bridge?.files.pickFolder && <button type="button" class="button secondary" onClick={() => void choose()}>Choose…</button>}
        </span>
      </label>
      {finding && (
        <>
          <label class="folder-agent-field"><span class="folder-agent-label">Name</span>
            <input class="input" value={name} maxLength={80} aria-label="Name" onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)} /></label>
          <label class="folder-agent-field"><span class="folder-agent-label">Role <small>(from {finding.source})</small></span>
            <input class="input" value={role} maxLength={80} aria-label="Role" onInput={(event) => setRole((event.currentTarget as HTMLInputElement).value)} /></label>
          <div class="folder-agent-field"><span class="folder-agent-label">Access</span>
            <Select label="Access mode" value={mode} options={MODE_OPTIONS} onChange={setMode} /></div>
          <Found title="Follows" items={finding.instructions} empty="No instruction files (CLAUDE.md, AGENTS.md …)" />
          <Found title="Skills" items={finding.skills} empty="No skills in this folder" />
          {finding.configs.length > 0 && <Found title="Other tools' settings (read only)" items={finding.configs} empty="" />}
          {finding.agents.length > 0 && <Found title="Already working here" items={finding.agents.map((agent) => agent.name)} empty="" />}
        </>
      )}
      <ExplorerLine />
      <DialogActions message={message}>
        <button type="button" class="button secondary" onClick={props.onClose}>Cancel</button>
        <button type="button" class="button primary" disabled={!finding || busy || !name.trim()} onClick={() => void create()}>Create agent</button>
      </DialogActions>
    </form>
  );
}

export function FolderAgentHost() {
  const request = folderAgentRequest.value;
  if (!request || !isOwner()) return null;
  const close = () => { folderAgentRequest.value = null; };
  return (
    <Dialog open onClose={close} title="Agent from folder" width={560} class="anchored folder-agent-dialog">
      <FolderAgentForm key={request.folder ?? ''} start={request.folder} onClose={close} />
    </Dialog>
  );
}
