// The one route table (a fixed frame draws the surfaces and header rows, the views hand over content and cell
// data): for every route what the desktop frame's side and main zones show and what the phone stack shows.
// Shell.tsx, Sidebar.tsx and MobileShell.tsx draw the zones from it; nothing else switches on the route.
//   side  – the sidebar's content and its header as data (the navs: Chats, Team, Work, My day, Settings)
//   main  – the main zone's content; `header` when the route hands its header row over as data (the empty
//           #/chats). Without it the view draws its own top row with lib/header.tsx.
//   phone – the stack: tab root or pushed (back, no tab bar), the top row's title, the body, the nav's header
//           data when the body is a nav (its search replaces the palette search), and `ownHeader` when the
//           body draws its own top row with Back as its lead (a chat, an agent, a person) – one top row.
// A chat route on a connection that may not read chats (To-do-only phone) shows My day (shell/gates.ts).
// The default route 'home' is a pure alias of 'day': the same My day (DayView, with today's briefing on top) in the same
// zones with the same key, so going between them changes nothing on screen; while the first run is open its place on
// 'home' and 'day' show the setup assistant (onboarding/FirstRun.tsx).
// Owns: route → view mapping, the phone's title and push rule. Never: layout chrome, header markup or view content.

import { h } from 'preact';
import type { ComponentChildren } from 'preact';
import { Header } from '../lib/header.tsx';
import type { HeaderProps, HeaderZone } from '../lib/header.tsx';
import type { Route } from '../lib/router.ts';
import { DESTINATIONS } from '../lib/vocab.ts';
import type { NavKey } from '../lib/vocab.ts';
import { ChatView } from '../chat/ChatView.tsx';
import { ChatList, chatListHeader } from '../chat/ChatList.tsx';
import { FirstRun } from '../onboarding/FirstRun.tsx';
import { firstRunActive } from '../onboarding/first-run.ts';
import { FIRST_RUN_TITLE } from '../onboarding/first-run-model.ts';
import { DayView } from '../day/DayView.tsx';
import { DayNav, dayNavHeader } from '../day/DayNav.tsx';
import { TasksView, workSearchHeader } from '../tasks/TasksView.tsx';
import { TeamView } from '../team/TeamView.tsx';
import { TeamNav, teamNavHeader } from '../team/TeamNav.tsx';
import { AgentView } from '../team/AgentView.tsx';
import { PersonView } from '../team/PersonView.tsx';
import { SplitView } from '../splits/SplitView.tsx'; // B-057: #/team/<agentId>/split/<splitId>
import { Settings, settingsSectionTitle } from '../settings/Settings.tsx';
import { SettingsNav, settingsNavHeader } from '../settings/SettingsNav.tsx';
import { TaskFiltersNav, taskFiltersHeader } from './TaskFiltersNav.tsx';
import { ProjectsNav, projectsNavHeader } from '../projects/ProjectsNav.tsx'; // AF-018
import { ProjectPage, ProjectsHome } from '../projects/ProjectPage.tsx';
import { chatRouteAllowed } from './gates.ts';

/** A zone's header row as data (lib/header.tsx props; the frame sets the zone). */
export type HeaderSource = () => HeaderProps;

export interface ZoneView {
  /** The frame remounts the zone's content (and header) when this changes. */
  key: string;
  body: ComponentChildren;
  /** The zone's header row as data; absent = the body draws its own top row (main zone only). */
  header?: HeaderSource;
}

export interface DesktopViews {
  side: ZoneView & { header: HeaderSource };
  main: ZoneView;
}

export interface PhoneView {
  key: string;
  body: ComponentChildren;
  /** Pushed on top of a tab: the body's own top row with Back, no tab bar. */
  pushed: boolean;
  /** The top row's title ('' when the body's own heading names it). */
  title: string;
  /** The frame's row has Back to Home (the settings list) or to all settings (a page); pushed screens draw their own row with Back. */
  back: 'home' | 'settings' | null;
  /** The body's header data – a nav's (Chats) or Work's: its search takes the place of the palette search. */
  header?: HeaderSource;
  /** The body draws its own top row (every pushed screen – ownsTopRow): the frame draws none. */
  ownHeader: boolean;
}

/** Draws a zone's header row from its source (keyed by the zone's key in the frame). */
export function ZoneHeader(props: { read: HeaderSource; zone: HeaderZone }) {
  return h(Header, { ...props.read(), zone: props.zone });
}

/** The chat route's view: the chat, or My day where this connection may not read chats. */
function chatBody(id: string): { key: string; body: ComponentChildren } {
  return chatRouteAllowed() ? { key: `chat:${id}`, body: h(ChatView, { key: id, conversationId: id }) } : { key: 'day', body: h(DayView, null) };
}

function sideView(current: Route): DesktopViews['side'] {
  switch (current.view) {
    case 'team': return { key: 'team', body: h(TeamNav, null), header: teamNavHeader };
    case 'settings': return { key: 'settings', body: h(SettingsNav, null), header: settingsNavHeader };
    case 'tasks': return { key: 'tasks', body: h(TaskFiltersNav, null), header: taskFiltersHeader };
    case 'projects': return { key: 'projects', body: h(ProjectsNav, null), header: projectsNavHeader }; // AF-018
    case 'home': // the same My day as 'day': one side column
    case 'day': return { key: 'day', body: h(DayNav, null), header: dayNavHeader }; // B-041: mini month, connected calendars
    default: return { key: 'chats', body: h(ChatList, null), header: chatListHeader };
  }
}

/** The team route's page: a person, a split of an agent (B-057), an agent or the overview. */
function teamBody(current: Extract<Route, { view: 'team' }>): { key: string; body: ComponentChildren } {
  if (current.personId) return { key: `person:${current.personId}`, body: h(PersonView, { key: current.personId, personId: current.personId }) };
  if (current.agentId && current.splitId) return { key: `split:${current.splitId}`, body: h(SplitView, { key: current.splitId, agentId: current.agentId, splitId: current.splitId }) };
  if (current.agentId) return { key: `agent:${current.agentId}`, body: h(AgentView, { key: current.agentId, agentId: current.agentId }) };
  return { key: 'team', body: h(TeamView, null) };
}

/** AF-018: the projects route's page – one project, or the start page. */
function projectsBody(current: Extract<Route, { view: 'projects' }>): { key: string; body: ComponentChildren } {
  return current.id ? { key: `project:${current.id}`, body: h(ProjectPage, { key: current.id, projectId: current.id }) } : { key: 'projects', body: h(ProjectsHome, null) };
}

const EMPTY_CHATS: HeaderSource = () => ({ title: '' });

function mainView(current: Route): ZoneView {
  switch (current.view) {
    case 'chat': return chatBody(current.id);
    case 'day': return firstRunActive() ? { key: 'first-run', body: h(FirstRun, null) } : { key: 'day', body: h(DayView, null) }; // AF-002: My day's button never hides the setup
    case 'chats': return { key: 'chats', body: h('div', { class: 'main-empty' }), header: EMPTY_CHATS };
    case 'tasks': return { key: 'tasks', body: h(TasksView, null) };
    case 'team': return teamBody(current);
    case 'projects': return projectsBody(current);
    case 'settings': return { key: 'settings', body: h(Settings, null) };
    default: return firstRunActive() ? { key: 'first-run', body: h(FirstRun, null) } : { key: 'day', body: h(DayView, null) };
  }
}

/** The desktop frame's side and main zones for a route. */
export function desktopViews(current: Route): DesktopViews {
  return { side: sideView(current), main: mainView(current) };
}

/** The top row's title of a tab: the destination's name, Settings for the settings list. */
export function tabTitle(current: Route): string {
  if (current.view === 'settings') return 'Settings';
  if ((current.view === 'home' || current.view === 'day') && firstRunActive()) return FIRST_RUN_TITLE; // the computer's header says the same
  const key: NavKey = current.view === 'chat' ? 'chats' : current.view;
  return DESTINATIONS[key];
}

/** Pushed screens: a chat, an agent and a person. */
export function isPushed(current: Route): boolean {
  if (current.view === 'chat') return chatRouteAllowed();
  if (current.view === 'projects') return !!current.id; // AF-018: a project's page lies over the list
  return current.view === 'team' && !!(current.agentId || current.personId);
}

/** The phone body draws its own top row (Back as its lead): every pushed screen – the frame's row has no
 *  Back for them, so a new pushed screen must bring its own (lib/header.tsx backCell). */
export function ownsTopRow(current: Route): boolean {
  return isPushed(current);
}

/** The phone stack for a route. */
export function phoneView(current: Route): PhoneView {
  const pushed = isPushed(current);
  switch (current.view) {
    case 'chat': {
      const chat = chatBody(current.id);
      return { ...chat, pushed, title: pushed ? '' : tabTitle({ view: 'day' }), back: null, ownHeader: ownsTopRow(current) };
    }
    case 'chats': return { key: 'chats', body: h(ChatList, null), pushed, title: tabTitle(current), back: null, header: chatListHeader, ownHeader: false };
    case 'tasks': return { key: 'tasks', body: h(TasksView, null), pushed, title: tabTitle(current), back: null, header: workSearchHeader, ownHeader: false }; // Work's own search in the top row
    case 'settings': return current.section
      ? { key: 'settings', body: h(Settings, null), pushed, title: settingsSectionTitle(current.section), back: 'settings', ownHeader: false }
      : { key: 'settings-list', body: h(SettingsNav, null), pushed, title: tabTitle(current), back: 'home', header: settingsNavHeader, ownHeader: false };
    case 'projects': {
      const page = current.id ? projectsBody(current) : { key: 'projects-list', body: h(ProjectsNav, null) }; // AF-018: the list is the tab's root
      return { ...page, pushed, title: pushed ? '' : tabTitle(current), back: null, ...(pushed ? {} : { header: projectsNavHeader }), ownHeader: ownsTopRow(current) };
    }
    case 'team': {
      const page = teamBody(current);
      return { ...page, pushed, title: pushed ? '' : tabTitle(current), back: null, ownHeader: ownsTopRow(current) };
    }
    default: {
      const page = mainView(current);
      return { key: page.key, body: page.body, pushed, title: tabTitle(current), back: null, ownHeader: false };
    }
  }
}
