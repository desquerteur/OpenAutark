// #/team without an agent or a person: the org chart lives in the sidebar tree (TeamNav.tsx); the main zone shows
// the agent directory (AF-017, agents/AgentDirectory.tsx) – every agent with its project, status and chat. On the
// phone the Team tab IS that tree, with the directory one tap away ("All agents").
// Owns: this main page and the phone's tab body. Never: draws a second org tree.

import { signal } from '@preact/signals';
import { Header } from '../lib/header.tsx';
import { isMobile } from '../lib/store.ts';
import { TeamNav } from './TeamNav.tsx';
import { AgentDirectory } from '../agents/AgentDirectory.tsx'; // AF-017

/** The phone's choice between the org chart and the directory. */
const phoneTab = signal<'chart' | 'directory'>('chart');

export function TeamView() {
  if (isMobile.value) {
    const tab = phoneTab.value;
    return (
      <div class="team-view">
        <div class="team-tabs" role="tablist" aria-label="Team">
          <button type="button" role="tab" aria-selected={tab === 'chart'} class="directory-seg" onClick={() => { phoneTab.value = 'chart'; }}>Org chart</button>
          <button type="button" role="tab" aria-selected={tab === 'directory'} class="directory-seg" onClick={() => { phoneTab.value = 'directory'; }}>All agents</button>
        </div>
        <div class="team-scroll">{tab === 'chart' ? <TeamNav /> : <AgentDirectory />}</div>
      </div>
    );
  }
  return (
    <div class="team-view">
      <Header zone="main" class="team-header" title="Team" />
      <div class="team-scroll"><AgentDirectory /></div>
    </div>
  );
}
