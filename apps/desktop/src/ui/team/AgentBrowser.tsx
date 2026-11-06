// An agent's own browser and its own area on its page in Team (B-055, Bauherr – the owner: "wenn man … als CEO … auf
// einen Agent draufgeht, kann man sich den Browser, was der gerade da macht … anschauen. Aber
// grundsätzlich … ist es wirklich der Browser von einem persönlichen"; B-072: "Und es soll es auch pro Agent geben, aber
// das verwaltet dann halt der Agent selber"): the agent page's Browser cell (AgentView.tsx) switches its content to this
// view, two fixed halves. Above, the live view of the agent's own browser (workspace/BrowserLive.tsx: tabs, Take over /
// Hand back, Show window, named cursors); closed, it says so (it opens when the agent browses). Below, the agent's area:
// one workspace surface (workspace/WorkspacePane.tsx) on its space agent:<id> – the pages it shows there (browser.show
// where: own) and the panels it lists there in side-tabs.json. The agent keeps it; the person looks and may use it. The
// area's full view (its menu) gives it the whole view while the live view leaves. Watching runs only while the live view
// shows (browser-feed.ts).
// Owns: this view and its two slots. Never: runs a feed of its own, keeps watching after it closes, or tab logic (pages.ts).

import { agentSpace } from '../../shared/api/workspace-browser.ts';
import { agentName } from '../lib/store.ts';
import { BrowserLive } from '../workspace/BrowserLive.tsx';
import { fullView } from '../workspace/full-view.ts';
import { WorkspacePane } from '../workspace/WorkspacePane.tsx';

export function AgentBrowser(props: { agentId: string }) {
  const name = agentName(props.agentId);
  const space = agentSpace(props.agentId);
  const full = fullView.value === space;
  return (
    <div class={`agent-split${full ? ' area-full' : ''}`}>
      {!full && (
        <div key="live" class="workspace-body tab-screen tab-browser agent-browser" role="region" aria-label={`${name}'s browser`}>
          <BrowserLive key={props.agentId} target={{ agentId: props.agentId }} />
        </div>
      )}
      <section key="area" class="agent-area" aria-label={`${name}'s area`}>
        <WorkspacePane key={space} space={space} />
      </section>
    </div>
  );
}
