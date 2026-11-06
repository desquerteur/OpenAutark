// Small team pieces: an agent avatar with its real status (rotating ring only for a live run,
// a small dot for waiting / paused / error), the one-line status text, and the tiny muted "AI"
// after an agent's name in Team (B-041 §8: next to the rounded-square avatar, humans and AI are
// told apart at first sight; a person never gets it).
// Owns: their markup and accessible labels. Never: fakes a working state – "working" comes
// from the live activity signal or the agent row.

import type { Agent } from '../../shared/model/org.ts';
import { Avatar } from '../lib/ui.tsx';
import { AGENT_STATUS_LABELS, agentStatusLine, effectiveStatus } from './model.ts';
import { liveByAgent } from './org-state.ts';

export function AgentStatusAvatar(props: { agent: Agent; size?: number; onClick?: (event: MouseEvent) => void }) {
  const { agent } = props;
  const status = effectiveStatus(agent, liveByAgent.value.get(agent.id));
  const label = status === 'idle' ? agent.name : `${agent.name} · ${AGENT_STATUS_LABELS[status]}`;
  return (
    <span class={`agent-status-avatar status-${status}`}>
      <Avatar name={agent.name} avatar={agent.avatar} seed={agent.id} size={props.size ?? 30} working={status === 'working'} title={label} onClick={props.onClick} agent />
      {(status === 'waiting' || status === 'paused' || status === 'error') && <span class="agent-status-dot" aria-hidden="true" />}
    </span>
  );
}

export function agentLine(agent: Agent): string {
  return agentStatusLine(agent, liveByAgent.value.get(agent.id));
}

/** The tiny muted "AI" after an agent's name (Team lists, the agent and person pages). */
export function AiTag() {
  return <span class="ai-tag" title="AI agent">AI</span>;
}
