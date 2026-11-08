// AF-017: the agent page's "where is it" line under the profile – its project (AF-018) or "No project", its team,
// who hired it and when, its status now, and the direct ways on: Open chat (its 1:1), Show work and Show in project.
// Opening the page clears the agent's "new" mark in the directory.
// Owns: this line. Never: edits the agent.

import { useEffect } from 'preact/hooks';
import type { Agent } from '../../shared/model/org.ts';
import { Button, Icon } from '../lib/ui.tsx';
import { dayMonth, fullDate } from '../lib/format.ts';
import { go } from '../lib/router.ts';
import { canMessage } from '../chat/direct.ts';
import { STATUS_LABELS } from './directory-model.ts';
import { directoryEntries, markAgentSeen, openAgentChat, showInProject, watchDirectory } from './directory-state.ts';

export function AgentWhereabouts(props: { agent: Agent }) {
  const { agent } = props;
  useEffect(() => { watchDirectory(); }, []);
  useEffect(() => { markAgentSeen(agent.id); }, [agent.id]);
  const entry = directoryEntries.value.find((item) => item.agent.id === agent.id);
  const archived = agent.archivedAt !== undefined;
  return (
    <div class="agent-whereabouts" data-tour="agent-whereabouts">
      <dl class="whereabouts-facts">
        <div><dt>Project</dt><dd>{entry?.project
          ? <button type="button" class="text-button" onClick={() => showInProject(entry.project!.id)}><Icon name="folder" size={12} /> {entry.project.name}</button>
          : <span class="muted">No project</span>}</dd></div>
        {entry?.team && <div><dt>Team</dt><dd>{entry.team}</dd></div>}
        <div><dt>Hired</dt><dd title={fullDate(agent.createdAt)}>by {entry?.createdBy ?? (agent.createdBy === 'human' ? 'You' : 'an agent')} · {dayMonth(agent.createdAt)}</dd></div>
        {entry && <div><dt>Now</dt><dd><span class={`directory-status status-${entry.status}`}>{STATUS_LABELS[entry.status]}</span>{entry.activity !== agent.role && <span class="whereabouts-activity"> {entry.activity}</span>}</dd></div>}
      </dl>
      <div class="whereabouts-actions">
        {!archived && canMessage(agent.id) && <Button variant="primary" class="small" icon="chat-circle" onClick={() => openAgentChat(agent.id)}>Open chat</Button>}
        <Button variant="secondary" class="small" onClick={() => go.tasks(undefined, agent.id)}>Show work</Button>
      </div>
    </div>
  );
}
