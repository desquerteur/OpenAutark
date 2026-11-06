// "Archived (n)" at the end of the team sidebar list: a collapsed group of the archived agents, newest first. A row
// opens the agent's page (read-only); its right-click menu (menus.ts agentMenu) offers Restore. Loaded with
// agents.list {includeArchived} when the list opens and after each reconnect, then kept current by 'agent.upserted'
// (an archived agent comes in, a restored one goes out). Nothing shows while no agent is archived; opening the group
// only adds rows below it, so nothing above moves.
// Owns: this group. Never: archives or restores by itself (the menu does) or polls.

import { useEffect, useState } from 'preact/hooks';
import type { Agent } from '../../shared/model/org.ts';
import { useContextMenu } from '../lib/context-menu.tsx';
import { relative } from '../lib/format.ts';
import { rpc } from '../lib/rpc.ts';
import { go } from '../lib/router.ts';
import { route } from '../lib/store.ts';
import { Avatar, Icon } from '../lib/ui.tsx';
import { agentMenu } from './menus.ts';
import { applyArchived } from './model.ts';

function useArchived(): Agent[] {
  const [list, setList] = useState<Agent[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      rpc.call('agents.list', { includeArchived: true })
        .then((all) => { if (alive) setList(all.reduce(applyArchived, [] as Agent[])); })
        .catch(() => undefined); // where the list may not be read there is simply no group
    };
    load();
    const offOpen = rpc.onOpen(load);
    const offUpserted = rpc.on('agent.upserted', (agent) => setList((current) => applyArchived(current, agent)));
    return () => { alive = false; offOpen(); offUpserted(); };
  }, []);
  return list;
}

function ArchivedRow(props: { agent: Agent; active: boolean }) {
  const { agent } = props;
  const menu = useContextMenu(() => agentMenu(agent));
  return (
    <div class={`team-row archived${props.active ? ' active' : ''}`} {...menu}>
      <span class="team-caret-space" aria-hidden="true" />
      <button type="button" class="team-row-open" aria-current={props.active ? 'page' : undefined} onClick={() => go.agent(agent.id)}>
        <Avatar name={agent.name} avatar={agent.avatar} seed={agent.id} size={30} agent />
        <span class="team-row-text">
          <span class="row-title">{agent.name}</span>
          {agent.archivedAt !== undefined && <span class="row-preview">Archived {relative(agent.archivedAt)}</span>}
        </span>
      </button>
    </div>
  );
}

export function ArchivedGroup() {
  const list = useArchived();
  const [open, setOpen] = useState(false);
  const current = route.value;
  const activeId = current.view === 'team' ? current.agentId : undefined;
  if (!list.length) return null;
  return (
    <div class="team-space team-archived">
      <button type="button" class="team-archived-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'caret-down' : 'caret-right'} size={12} />
        <span>Archived ({list.length})</span>
      </button>
      {open && list.map((agent) => <ArchivedRow key={agent.id} agent={agent} active={agent.id === activeId} />)}
    </div>
  );
}
