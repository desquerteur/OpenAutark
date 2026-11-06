// #/team without an agent or a person: the org lives in ONE place, the sidebar tree (TeamNav.tsx). On a
// computer the main zone stays calm and points at it; on the phone the Team tab IS that tree.
// Owns: this empty main page and the phone's tab body. Never: draws a second org tree.

import { EmptyState } from '../lib/ui.tsx';
import { Header } from '../lib/header.tsx';
import { isMobile } from '../lib/store.ts';
import { TeamNav } from './TeamNav.tsx';

export function TeamView() {
  if (isMobile.value) return <div class="team-view"><div class="team-scroll"><TeamNav /></div></div>;
  return (
    <div class="team-view">
      <Header zone="main" class="team-header" title="Team" />
      <EmptyState>Pick an agent or a person.</EmptyState>
    </div>
  );
}
