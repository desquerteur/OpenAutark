// The frame's side zone: one persistent sidebar across all routes – its header row (the nav's
// header data from shell/views.ts, drawn by lib/header.tsx) sits above the scrolling body, so
// neither scrolling nor a focused search field can move the heading; the zone clips (shell.css),
// the body reserves its scrollbar gutter. The divider grip resizes it.
// Owns: the side zone's structure and its width preference. Never: navigation contents or which
// nav a route shows (views.ts).

import { updatePreferences } from '../lib/store.ts';
import { ColumnResize } from './ColumnResize.tsx';
import { ZoneHeader } from './views.ts';
import type { DesktopViews } from './views.ts';

export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_DEFAULT = 288;

export function Sidebar(props: { view: DesktopViews['side']; width: number; onLiveWidth: (width: number | null) => void }) {
  const { view } = props;
  return <>
    <aside class="sidebar" aria-label="Sidebar" data-tour="sidebar">
      <ZoneHeader key={view.key} read={view.header} zone="side" />
      <div class="sidebar-body" key={view.key}>{view.body}</div>
    </aside>
    <ColumnResize label="Resize sidebar" class="sidebar-resize" width={props.width} min={SIDEBAR_MIN} max={SIDEBAR_MAX}
      defaultWidth={SIDEBAR_DEFAULT} onLive={props.onLiveWidth} onSave={(width) => updatePreferences({ sidebarWidth: width })} />
  </>;
}
