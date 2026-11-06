// One surface of the workspace, built like a browser, showing one space: the person's pane at the frame's right (global;
// on a wide window its tab strip is the window's title row), a chat's area above its messages (chat/ChatArea.tsx) or an
// agent's own area on its agent page (team/AgentBrowser.tsx). The
// tab strip on top (TabStrip.tsx), under it the address row (BrowserHeader.tsx) and the shown tab – a website (BrowserPage.tsx, a blank tab
// there is the new-tab page) or one of the app's own panels: My day, Work, Activity, a chat's Notes, a Media item or the
// library, a chat's Video work, this PC's Screen, an agent's own browser (which brings its own toolbar in the address row's
// place), a file or folder by its path, a view from <data>/pages, a website running on another PC (RemoteWebTab.tsx,
// B-076: its live picture, with its own toolbar in the address row's place). Its parts read the space from SpaceContext
// (space.ts); only the shown tab exists: a panel mounts when shown and a website's native page lives by main's rules.
// The phone shows its PC's spaces (phone-tabs.ts); a PWA without them has no browser: app tabs still show, and an
// empty surface says so.
// Owns: which tab is shown and the surface's parts. Never: tab logic (pages.ts) or page content.

import { useEffect } from 'preact/hooks';
import { Boundary } from '../blocks/Boundary.tsx';
import { DayPanel } from '../day/DayPanel.tsx';
import { agentName } from '../lib/store.ts';
import { Icon } from '../lib/ui.tsx';
import { WorkIndex } from '../tasks/WorkIndex.tsx';
import { ActivityView } from '../team/ActivityView.tsx';
import { BrowserHeader } from './BrowserHeader.tsx';
import { BrowserLive } from './BrowserLive.tsx';
import { BrowserPage } from './BrowserPage.tsx';
import { isAppTab, shownId, type AppEntry } from './browser-model.ts';
import { FileView } from './FileView.tsx';
import { FolderView } from './FolderView.tsx';
import { fullView } from './full-view.ts';
import { MediaLibrary } from './MediaLibrary.tsx';
import { MediaView } from './MediaView.tsx';
import { NotesView } from './NotesView.tsx';
import { PageView } from './PageView.tsx';
import { watchUserPages } from './user-pages.ts';
import { watchBrowserKeys } from './pane-shortcuts.ts';
import { ensureTab, hasPersonalBrowser, pagesListed, shownOf, tabsOf, watchPersonalBrowser } from './pages.ts';
import { PaneMenu } from './PaneMenu.tsx';
import { phonePane, watchPhoneTabs } from './phone-tabs.ts';
import { RemoteWebTab } from './RemoteWebTab.tsx';
import { ScreenView } from './ScreenView.tsx';
import { SpaceContext } from './space.ts';
import { tabInfosOf } from './tab-list.ts';
import { TabStrip } from './TabStrip.tsx';
import { VideoView } from './VideoView.tsx';

function AppTabView(props: { entry: AppEntry }) {
  const { entry } = props;
  if (entry.kind === 'day') return <div class="pane-view pane-scroll"><DayPanel /></div>;
  if (entry.kind === 'work') return <WorkIndex />;
  if (entry.kind === 'activity') return <ActivityView />;
  if (entry.kind === 'agent') {
    return (
      <div class="workspace-body tab-browser agent-browser" role="region" aria-label={`${agentName(entry.agentId)}'s browser`}>
        <BrowserLive key={entry.agentId} target={{ agentId: entry.agentId }} trail={<PaneMenu id={entry.id} />} />
      </div>
    );
  }
  if (entry.kind === 'notes') return <NotesView conversationId={entry.conversationId} />;
  if (entry.kind === 'media') return entry.fileId || entry.path ? <MediaView id={entry.id} fileId={entry.fileId} path={entry.path} device={entry.device} /> : <MediaLibrary />;
  if (entry.kind === 'video') return <VideoView conversationId={entry.conversationId} fileId={entry.fileId} />;
  if (entry.kind === 'file') return <FileView id={entry.id} path={entry.path} device={entry.device} />;
  if (entry.kind === 'folder') return <FolderView id={entry.id} path={entry.path} device={entry.device} />;
  if (entry.kind === 'page') return <PageView name={entry.name} />;
  if (entry.kind === 'remote') {
    return (
      <div class="workspace-body tab-browser remote-browser" role="region" aria-label="Website on another PC">
        <RemoteWebTab key={entry.id} device={entry.device} tab={entry.tab} url={entry.url} title={entry.title} trail={<PaneMenu id={entry.id} />} />
      </div>
    );
  }
  return <ScreenView />;
}

export function WorkspacePane(props: { space: string }) {
  const { space } = props;
  useEffect(() => {
    watchPersonalBrowser(); watchBrowserKeys(); watchUserPages();
    return () => { if (fullView.peek() === space) fullView.value = null; }; // the surface closed: its full view ends with it
  }, [space]);
  const entries = tabsOf(space);
  const ids = entries.map((page) => page.id);
  const listed = pagesListed.value;
  const phone = phonePane(); // follows the session: a phone may read its PC's pane once the runtime said who it is
  useEffect(() => { if (phone) watchPhoneTabs(); }, [phone]);
  useEffect(() => { ensureTab(space); }, [listed, ids.length, space]);
  if (!hasPersonalBrowser() && !phone && !ids.length) {
    return <div class="workspace-pane" data-space={space}><div class="workspace-start"><Icon name="globe" size={24} /><p>The browser is part of the desktop app.</p></div></div>;
  }
  const id = shownId(ids, shownOf(space));
  const entry = entries.find((page) => page.id === id);
  const own = entry?.kind === 'agent' || entry?.kind === 'remote'; // brings its own toolbar
  return (
    <SpaceContext.Provider value={space}>
      <div class="workspace-pane" data-space={space}>
        <TabStrip tabs={tabInfosOf(space)} shown={id} />
        {!own && <BrowserHeader id={id} />}
        <Boundary key={id}>{isAppTab(entry) ? <AppTabView entry={entry} /> : phone && !listed ? <div class="browser-body" /> : <BrowserPage id={id} />}</Boundary>
      </div>
    </SpaceContext.Provider>
  );
}
