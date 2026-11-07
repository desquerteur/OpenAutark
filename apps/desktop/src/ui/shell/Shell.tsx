// The one persistent frame (the frame draws the surfaces and header rows, views hand over content and cell
// data – shell/views.ts). Desktop zones, left to right:
//   rail | side (Sidebar: header row + scrolling body, resizable) | main
// and the person's own workspace pane (the global space, resizable) below the header row at the right, in the room the
// main zone keeps free for it: the main zone's header row runs on over the pane, so opening or closing it moves no header
// cell. Its tab strip is the row's part above it (`strip-in-row`) only where the row leaves it room for three titled tabs
// after the caption controls and the frame's cells (measured on .pane-row-room, shell.css; strip-slots.ts ROW_ROOM), else
// its first line under the row: a drag of the pane or the window may move the strip, a click never does.
// Each zone's header row is the top --header-h of the zone; its body scrolls below it. The main zone
// is `rightmost` (shell.css turns that into --caption-space: the caption controls plus the frame's workspace
// and feedback cells, WindowBar.tsx). The status line (StatusLine.tsx) lies over the top of the main zone.
// In full view (workspace/full-view.ts) the pane lies over the main zone's body. A chat's own tabs are its area
// in the chat column (chat/ChatArea.tsx), not here.
// Plus the global overlays (palette, new chat, feedback, confirm, Mark a region). The phone layout
// (MobileShell) is the same frame as a stack; the global tabs are a pushed sheet there instead of the pane.
// Owns: layout composition, the caption assignment and global hotkeys. Never: view content.

import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { GLOBAL_SPACE } from '../../shared/api/workspace-browser.ts';
import { isMobile, loadError, loaded, preferences, route, updatePreferences } from '../lib/store.ts';
import { rpc } from '../lib/rpc.ts';
import { bridge } from '../lib/platform.ts';
import { hotkey } from '../lib/hotkeys.ts';
import { toggleSettings } from '../lib/router.ts';
import { ConfirmHost } from '../lib/dialog.tsx';
import { AccessRequestHost } from './AccessRequestDialog.tsx'; // AF-013: approval requests
import { FolderAgentHost } from '../team/FolderAgentDialog.tsx'; // AF-014: agent from folder
import { RememberWhyHost } from '../chat/RememberWhy.tsx';
import { Spinner } from '../lib/ui.tsx';
import { newChatOpen, paletteOpen } from '../lib/shell-state.ts';
import { canStartChat } from './gates.ts';
import { FeedbackCell, toggleSidebar, WorkspaceCell } from './WindowBar.tsx';
import { Rail } from './Rail.tsx';
import { Sidebar, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from './Sidebar.tsx';
import { desktopViews, ZoneHeader } from './views.ts';
import { StatusLine, registerShellNotices } from './StatusLine.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { MobileShell } from './MobileShell.tsx';
import { NewChatDialog } from '../chat/NewChatDialog.tsx';
import { WorkspacePane } from '../workspace/WorkspacePane.tsx';
import { watchWorkspaceAttention } from '../workspace/attention.ts'; // B-044: the cells' dots, browser.show, where ways in land
import { fullView } from '../workspace/full-view.ts';
import { ROW_ROOM } from '../workspace/strip-slots.ts';
import { RegionDialog } from '../workspace/RegionDialog.tsx'; // once for both surfaces (its ask is one signal)
import { FeedbackMenu } from '../feedback/FeedbackMenu.tsx'; // B-055 Q4: the menu under the feedback cell, "Paint over"
import { ColumnResize } from './ColumnResize.tsx';
import { TourDialog } from '../tour/TourDialog.tsx'; // B-055: the feedback tour (replay)
import { CallOverlay } from '../chat/call/CallOverlay.tsx'; // AF-015: the call view (its own layer, not a panel)
import { SpotlightHost } from '../tour/Spotlight.tsx'; // AF-002: the spotlight tour and first-visit hints

function useGlobalHotkeys(): void {
  useEffect(() => {
    const off = [
      hotkey('mod+k', () => { paletteOpen.value = !paletteOpen.value; }),
      hotkey('mod+,', toggleSettings),
      hotkey('mod+b', toggleSidebar),
      hotkey('mod+n', () => { if (canStartChat()) newChatOpen.value = {}; }), // never a dialog whose Create is refused
    ];
    return () => off.forEach((fn) => fn());
  }, []);
}

/** Desktop: the caption controls follow the layout (main/title-bar.ts); sent on change only. */
function useCaptionLayout(compact: boolean): void {
  useEffect(() => { bridge?.setTitleBarLayout?.(compact ? 'compact' : 'columns'); }, [compact]);
}

function Overlays() {
  return (
    <>
      <CommandPalette />
      <NewChatDialog />
      <FeedbackMenu />
      <ConfirmHost />
      <AccessRequestHost />
      <FolderAgentHost />
      <RememberWhyHost />
      <TourDialog />
      <SpotlightHost />
      <RegionDialog />
      <CallOverlay />
    </>
  );
}

function DesktopShell() {
  const prefs = preferences.value;
  const sidebarShown = prefs.sidebarOpen;
  const live = useSignal<number | null>(null);
  const paneLive = useSignal<number | null>(null);
  const stored = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, prefs.sidebarWidth || SIDEBAR_DEFAULT));
  const width = live.value ?? stored;
  const paneWidth = paneLive.value ?? Math.max(280, Math.min(800, prefs.workspaceWidth || 400));
  const showPane = prefs.workspaceOpen;
  const rowRoom = useRef<HTMLDivElement>(null); // the strip's tab room in the title row (shell.css .pane-row-room)
  const stripInRow = useSignal(false);
  useLayoutEffect(() => {
    const element = rowRoom.current;
    if (!element) return;
    const measure = () => { stripInRow.value = element.getBoundingClientRect().width >= ROW_ROOM; };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { side, main } = desktopViews(route.value);
  return (
    <div class="app">
      <div class="shell">
        <Rail />
        <div
          class={`app-frame${sidebarShown ? '' : ' sidebar-closed'}${showPane ? ' with-pane' : ''}${showPane && fullView.value === GLOBAL_SPACE ? ' pane-full' : ''}${stripInRow.value ? ' strip-in-row' : ''}`}
          style={{ '--sidebar-width': `${width}px`, '--pane-width': `${paneWidth}px` }}
        >
          {sidebarShown && <Sidebar view={side} width={width} onLiveWidth={(value) => { live.value = value; }} />}
          <main class="main-slot rightmost" id="main">
            {main.header && <ZoneHeader key={main.key} read={main.header} zone="main" />}
            {main.body}
            <StatusLine />
          </main>
          {showPane && (
            <aside class="global-pane" aria-label="Workspace" id="workspace">
              <ColumnResize label="Resize workspace" class="workspace-resize" width={paneWidth} min={280} max={800} defaultWidth={400} direction={-1}
                onLive={(value) => { paneLive.value = value; }} onSave={(value) => updatePreferences({ workspaceWidth: value })} />
              <WorkspacePane space={GLOBAL_SPACE} />
            </aside>
          )}
          <WorkspaceCell />
          <FeedbackCell />
          <div class="pane-row-room" ref={rowRoom} aria-hidden="true" />
        </div>
      </div>
      <Overlays />
    </div>
  );
}

export function Shell() {
  useGlobalHotkeys();
  useCaptionLayout(isMobile.value);
  useEffect(() => registerShellNotices(), []);
  const ready = loaded.value || Boolean(loadError.value);
  useEffect(() => (ready ? watchWorkspaceAttention() : undefined), [ready]); // both layouts: the phone's ways in land in the open chat's area, else in its global sheet
  if (!ready) {
    return <div class="boot">{rpc.status.value === 'closed' ? <p class="muted">Offline</p> : <Spinner size={20} />}</div>;
  }
  if (isMobile.value) {
    return (
      <>
        <MobileShell />
        <Overlays />
      </>
    );
  }
  return <DesktopShell />;
}
