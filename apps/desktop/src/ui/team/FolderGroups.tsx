// AF-014: the Team list grouped by folder – one heading per home project folder (its name, the whole path as the
// tooltip) with the agents working there, then the agents without a folder. Several agents per folder are fine.
// Shown instead of the space groups while "Group agents by folder" is on (folder-agent.ts). The homes come from
// folderAgents.homes (owner) and are read again when an agent's folder or the team changes.
// Owns: this grouping. Never: renders an agent row itself (the caller's `row`).

import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import '../../shared/api/methods-folder-agents.ts';
import type { Agent } from '../../shared/model/org.ts';
import { rpc } from '../lib/rpc.ts';

import { folderGroups, type Home } from './folder-agent.ts';

export function FolderGroups(props: { agents: readonly Agent[]; row: (agent: Agent) => ComponentChildren }) {
  const [homes, setHomes] = useState<Home[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => { rpc.call('folderAgents.homes').then((list) => { if (alive) setHomes(list); }).catch(() => undefined); };
    load();
    const offCore = rpc.on('agentCore.changed', load);
    const offAgent = rpc.on('agent.upserted', load);
    return () => { alive = false; offCore(); offAgent(); };
  }, []);
  return (
    <>
      {folderGroups(props.agents, homes).map((group) => (
        <div class="team-space team-folder" key={group.folder ?? 'none'}>
          <div class="team-space-title" title={group.folder}>{group.label}</div>
          {group.agents.map((agent) => props.row(agent))}
        </div>
      ))}
    </>
  );
}
