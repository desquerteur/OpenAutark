// AF-017: the card a hire leaves in the chat it happened in (status line 'agent_hired', runtime/tools/builtin/
// hire-notice.ts): "New agent: Making", its role, its project (AF-018, once it works in one) or team, who hired it and
// when, with Open chat (its 1:1), Agent page and – when it has a project – Show in project. The agent's live
// values come from the store (a renamed agent shows its new name); the line's own words are the fallback for an
// agent this connection does not know (an older line, a narrower scope).
// Owns: the card's markup. Never: hires or changes the agent.

import type { Message } from '../../shared/model/chat.ts';
import { AgentAvatar, Button } from '../lib/ui.tsx';
import { agentMap, knownAgentMap } from '../lib/store.ts';
import { projectList } from '../lib/projects.ts';
import { time } from '../lib/format.ts';
import { useEffect } from 'preact/hooks';
import { projectOf } from '../agents/directory-model.ts';
import { openAgentChat, openAgentPage, showInProject, watchDirectory } from '../agents/directory-state.ts';
import { statusText } from './status-text.ts';

function detail(message: Message, key: string): string | undefined {
  const value = message.meta.status?.details?.[key];
  return typeof value === 'string' && value ? value : undefined;
}

export function AgentHiredCard(props: { message: Message }) {
  const { message } = props;
  useEffect(() => { watchDirectory(); }, []); // the agents' projects, kept fresh
  const agentId = detail(message, 'agentId');
  const agent = agentId ? knownAgentMap.value.get(agentId) : undefined;
  if (!agentId) return <div class="status-line" data-message-id={message.id}><span>{statusText(message)}</span><time class="tabular">{time(message.createdAt)}</time></div>;
  const active = agentMap.value.has(agentId);
  const name = agent?.name ?? detail(message, 'name') ?? 'Agent';
  const role = agent?.role ?? detail(message, 'role') ?? '';
  const by = detail(message, 'by');
  const byName = by ? knownAgentMap.value.get(by)?.name : undefined;
  const project = projectOf(agentId, projectList.value);
  const place = project ? `Project ${project.name}` : detail(message, 'space') ?? 'No project yet';
  const facts = [role, place, byName ? `hired by ${byName}` : ''].filter(Boolean).join(' · ');
  return (
    <section class="hire-card" data-message-id={message.id} aria-label={`New agent: ${name}`}>
      <AgentAvatar agentId={agentId} size={36} onClick={() => openAgentPage(agentId)} />
      <div class="hire-card-text">
        <div class="hire-card-title"><span class="hire-card-kicker">New agent</span><span class="hire-card-name">{name}</span>{!active && agent && <span class="hire-card-gone">archived</span>}</div>
        <div class="hire-card-facts">{facts}<time class="tabular">{time(message.createdAt)}</time></div>
      </div>
      <div class="hire-card-actions">
        {active && <Button variant="primary" class="small" onClick={() => openAgentChat(agentId)}>Open chat</Button>}
        <Button variant="secondary" class="small" onClick={() => openAgentPage(agentId)}>Agent page</Button>
        {project && <Button variant="secondary" class="small" onClick={() => showInProject(project.id)}>Show in project</Button>}
      </div>
    </section>
  );
}
