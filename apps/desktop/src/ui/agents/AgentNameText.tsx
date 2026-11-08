// AF-017: plain text with its agent names clickable – a chat row's title in Team activity, a row of the chat's agent
// tree. A click on a name opens that agent's page (and stops there: the row's own click does not run). The names sit
// inside the row's button, so they are a pointer shortcut only (not a second tab stop); the keyboard way to the agent
// is the row's menu ("Open <name>") and the agent's avatar.
// Owns: this markup. Never: matches names itself (agent-links.ts splitAgentNames).

import { agents } from '../lib/store.ts';
import { splitAgentNames } from './agent-links.ts';
import { openAgentPage } from './directory-state.ts';

export function AgentNameText(props: { text: string; exclude?: string }) {
  const list = agents.value.filter((agent) => agent.archivedAt === undefined && agent.id !== props.exclude);
  const pieces = splitAgentNames(props.text, list);
  if (pieces.length === 1 && !pieces[0].agentId) return <>{props.text}</>;
  return (
    <>
      {pieces.map((piece, index) => (piece.agentId
        ? <span key={index} class="agent-link" title={`Open ${piece.text.replace(/^@/, '')}`}
          onClick={(event) => { event.stopPropagation(); event.preventDefault(); openAgentPage(piece.agentId!); }}>{piece.text}</span>
        : piece.text))}
    </>
  );
}
