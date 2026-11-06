// Agent page (#/team/<agentId>, the avatar click target): identity and live status, a link to its work, its
// model, folder and skills, its schedules and its runs with tool calls and provider-visible reasoning
// summaries. The header (lib/header.tsx) has no icon cells: the agent's NAME is the dropdown, with the same
// menu as a right click on the agent anywhere (menus.ts agentMenu: Message · Browser · Connect Telegram… ·
// Duplicate · Change reports-to… · Export · Archive). "Browser" shows the live view of the agent's own browser and its own area (agent:<id>,
// AgentBrowser.tsx) instead of the profile, "Profile" brings it back. An archived agent is read-only with "Restore" in that menu. On the
// phone the header is the stack's one top row with Back as its lead (shell/views.ts ownsTopRow).
// Owns: the view frame and the name dropdown. Never: shows invented thoughts or fake status.

import { useEffect, useState } from 'preact/hooks';
import type { Agent } from '../../shared/model/org.ts';
import { EmptyState, Spinner } from '../lib/ui.tsx';
import { Header, backCell } from '../lib/header.tsx';
import type { HeaderCell } from '../lib/header.tsx';
import { useContextMenu } from '../lib/context-menu.tsx';
import { agentMap, isMobile } from '../lib/store.ts';
import { RpcError, rpc } from '../lib/rpc.ts';
import { back, go } from '../lib/router.ts';
import { AgentProfile } from './AgentProfile.tsx';
import { AgentDetails } from './AgentDetails.tsx';
import { AgentRuns } from './AgentRuns.tsx';
import { AgentBrowser } from './AgentBrowser.tsx';
import { TitleMenu } from './TitleMenu.tsx';
import { agentBrowser, agentMenu } from './menus.ts';
import { ensureSpaces } from './org-state.ts';
import { keptPage } from '../lib/kept-page.ts';

/** The agent from the store, or (archived / not yet loaded) fetched once. */
function useAgent(agentId: string): { agent: Agent | undefined; missing: boolean } {
  const fromStore = agentMap.value.get(agentId);
  const [fetched, setFetched] = useState<Agent | undefined>(undefined);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (fromStore) return;
    let alive = true;
    rpc.call('agents.get', { id: agentId })
      .then((agent) => { if (alive) setFetched(agent); })
      .catch((error) => { if (alive && error instanceof RpcError && error.code === 'not_found') setMissing(true); });
    return () => { alive = false; };
  }, [agentId, !!fromStore]);
  return { agent: fromStore ?? fetched, missing };
}

/** The phone's Back: this page draws the stack's one top row itself (shell/views.ts ownsTopRow). */
function phoneBack(): HeaderCell | undefined {
  return isMobile.value ? backCell(back) : undefined;
}

export function AgentView(props: { agentId: string }) {
  const { agent, missing } = useAgent(props.agentId);
  const menu = useContextMenu(() => (agent ? agentMenu(agent) : [])); // a right click on the page opens the agent menu (not over the browser view)
  useEffect(() => { ensureSpaces(); }, []);
  useEffect(() => () => { if (agentBrowser.peek() === props.agentId) agentBrowser.value = null; }, [props.agentId]); // leaving the page ends the browser view

  if (!agent) {
    return (
      <div class="agent-view">
        <Header zone="main" class="agent-header" lead={phoneBack()} title="" />
        <div class="agent-scroll"><div class="agent-column">{missing ? <EmptyState>This agent no longer exists.</EmptyState> : <Spinner />}</div></div>
      </div>
    );
  }

  const archived = agent.archivedAt !== undefined;
  return (
    <div class="agent-view">
      <Header zone="main" class="agent-header" lead={phoneBack()} title={<TitleMenu name={agent.name} sections={() => agentMenu(agent)} />} />
      {agentBrowser.value === agent.id ? <AgentBrowser agentId={agent.id} /> : <div class="agent-scroll" {...keptPage}>
        <div class="agent-column" {...menu}>
          {archived && <p class="agent-archived">Archived</p>}
          <AgentProfile agent={agent} readOnly={archived} />
          <button type="button" class="text-button agent-work-link" onClick={() => go.tasks(undefined, agent.id)}>Show work</button>
          <AgentDetails agent={agent} />
          <section class="agent-runs" aria-label="Runs">
            <h3 class="agent-section-title">Runs</h3>
            <AgentRuns agentId={agent.id} />
          </section>
        </div>
      </div>}
    </div>
  );
}
