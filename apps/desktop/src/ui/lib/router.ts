// Hash router for the single shell. Views:
//   #/home · #/day[/<YYYY-MM-DD>] · #/chats · #/chat/<id> · #/projects[/<projectId>] (AF-018)
//   · #/tasks[/<filter>][?owner=<agentId|team>][&task=<taskId>]
//   · #/team[/<agentId>] · #/team/<agentId>/split/<splitId> · #/team/person/<personId>
//   · #/settings[/<page>]  (a split's page under its agent; a Settings page, or an older name mapped to the page that
//     holds those rows, see settingsPage)
// ('day' is My day – today without a date; an older #/tasks/for-you link opens it. 'chats' is the
// phone list view; on desktop it shows the last chat or the empty main slot; `owner` – O5, "All
// work" on an agent's page – narrows the task lists to one agent or the team; `task` is the task
// open in Work's detail.) An in-app `<a href="#/…">` navigates through routeLink.
// Owns: the current route signal, parsing/formatting, navigation, in-app link clicks and back.
// Never: loads data – views react to the route themselves.

import { signal } from '@preact/signals';
import { isLocalDate } from '../../shared/model/calendar.ts';

export type Route =
  | { view: 'home' }
  | { view: 'day'; date?: string }
  | { view: 'chats' }
  | { view: 'chat'; id: string }
  | { view: 'projects'; id?: string } // AF-018: the Projects tab, one project open when `id` is set
  | { view: 'tasks'; filter?: string; owner?: string; task?: string }
  | { view: 'team'; agentId?: string; personId?: string; splitId?: string }
  | { view: 'settings'; section?: string };

export type RouteView = Route['view'];

/** The Settings pages (settings/sections.ts holds their titles and keywords), in nav order. */
export const SETTINGS_PAGES = ['general', 'appearance', 'personality', 'models', 'calendar', 'secrets', 'apps', 'skills', 'devices', 'feedback', 'updates', 'about'] as const; // AF-008: appearance; AF-006: personality; AF-019: updates
export type SettingsPage = (typeof SETTINGS_PAGES)[number];
export const DEFAULT_SETTINGS_PAGE: SettingsPage = 'general';

/** Other Settings names (older sections, the one-page groups) → the page that holds those rows now. */
const PAGE_OF: Readonly<Record<string, SettingsPage>> = {
  accounts: 'models', providers: 'models', routing: 'models', usage: 'models', abilities: 'models',
  voice: 'models', speech: 'models', // B-078: the Voice page joined Models
  knowledge: 'skills', memory: 'skills',
  permissions: 'secrets',
  connectors: 'apps', integrations: 'apps', mcp: 'apps', // AF-005: the Connectors page
  remote: 'devices', phone: 'devices', android: 'devices',
  profile: 'general', notifications: 'general', customize: 'general',
  themes: 'appearance', theme: 'appearance', layout: 'appearance', look: 'appearance', // AF-008
  advanced: 'about', privacy: 'about', backup: 'about', update: 'updates', // AF-019: Updates has its own page
};

/** The Settings page a section name opens: itself when it is one, the nearest page for an older name, else undefined (the first page). */
export function settingsPage(section: string | undefined): SettingsPage | undefined {
  if (!section) return undefined;
  const name = section.toLowerCase();
  const page = SETTINGS_PAGES.find((entry) => entry === name);
  return page ?? (Object.hasOwn(PAGE_OF, name) ? PAGE_OF[name] : undefined);
}

/** A settings route for a section name, mapped to its page. */
function settingsRoute(section: string | undefined): Route {
  const page = settingsPage(section);
  return page ? { view: 'settings', section: page } : { view: 'settings' };
}

export function parseRoute(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  switch (parts[0]) {
    case 'day': return isLocalDate(parts[1]) ? { view: 'day', date: parts[1] } : { view: 'day' }; // a day that does not exist opens today
    case 'chat': return parts[1] ? { view: 'chat', id: parts[1] } : { view: 'chats' };
    case 'chats': return { view: 'chats' };
    case 'projects': return parts[1] ? { view: 'projects', id: parts[1] } : { view: 'projects' };
    case 'tasks': {
      if (parts[1] === 'for-you') return { view: 'day' }; // For you moved to My day (B-041)
      const search = new URLSearchParams(query);
      const owner = search.get('owner') || undefined;
      const task = search.get('task') || undefined;
      return { view: 'tasks', ...(parts[1] ? { filter: parts[1] } : {}), ...(owner ? { owner } : {}), ...(task ? { task } : {}) };
    }
    case 'team':
      if (parts[1] === 'person') return parts[2] ? { view: 'team', personId: parts[2] } : { view: 'team' };
      if (parts[1] && parts[2] === 'split' && parts[3]) return { view: 'team', agentId: parts[1], splitId: parts[3] }; // B-057
      return parts[1] ? { view: 'team', agentId: parts[1] } : { view: 'team' };
    case 'settings':
      if (parts[1] === 'agents') return { view: 'team' }; // B-044: Settings › Agents went; its agents are on Team
      return settingsRoute(parts[1]);
    default: return { view: 'home' };
  }
}

export function formatRoute(route: Route): string {
  const enc = encodeURIComponent;
  switch (route.view) {
    case 'day': return route.date ? `#/day/${enc(route.date)}` : '#/day';
    case 'chat': return `#/chat/${enc(route.id)}`;
    case 'projects': return route.id ? `#/projects/${enc(route.id)}` : '#/projects';
    case 'tasks': {
      const query = [route.owner && `owner=${enc(route.owner)}`, route.task && `task=${enc(route.task)}`].filter(Boolean).join('&');
      return `#/tasks${route.filter ? `/${enc(route.filter)}` : ''}${query ? `?${query}` : ''}`;
    }
    case 'team':
      if (route.personId) return `#/team/person/${enc(route.personId)}`;
      if (route.agentId && route.splitId) return `#/team/${enc(route.agentId)}/split/${enc(route.splitId)}`;
      return route.agentId ? `#/team/${enc(route.agentId)}` : '#/team';
    case 'settings': return route.section ? `#/settings/${enc(route.section)}` : '#/settings';
    default: return `#/${route.view}`;
  }
}

export const route = signal<Route>(typeof location === 'undefined' ? { view: 'home' } : parseRoute(location.hash));

/** Last non-settings route, so closing Settings returns where the user was. */
let lastWorkRoute: Route = route.value.view === 'settings' ? { view: 'home' } : route.value;

export function navigate(requested: Route, options: { replace?: boolean } = {}): void {
  const next = requested.view === 'settings' ? settingsRoute(requested.section) : requested; // an older section name opens its page
  const hash = formatRoute(next);
  if (route.value.view !== 'settings') lastWorkRoute = route.value;
  if (location.hash === hash) { route.value = next; return; }
  if (options.replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
  route.value = next;
}

/**
 * Props of an in-app link, `<a {...routeLink(next)}>`: its '#/…' href, and a click that navigate()s
 * instead of the browser following the URL.
 */
export function routeLink(next: Route): { href: string; onClick: (event: Event) => void } {
  return { href: formatRoute(next), onClick: (event) => { event.preventDefault(); navigate(next); } };
}

export function closeSettings(): void {
  navigate(lastWorkRoute.view === 'settings' ? { view: 'home' } : lastWorkRoute);
}

export function toggleSettings(): void {
  if (route.value.view === 'settings') closeSettings();
  else navigate({ view: 'settings' });
}

export function back(): void {
  if (history.length > 1) history.back();
  else navigate({ view: 'home' });
}

export function startRouter(): void {
  window.addEventListener('popstate', () => { route.value = parseRoute(location.hash); });
  window.addEventListener('hashchange', () => { route.value = parseRoute(location.hash); });
}

/** Convenience helpers used across the app. */
export const go = {
  home: () => navigate({ view: 'home' }),
  /** My day: today, or the day `date` (YYYY-MM-DD). */
  day: (date?: string) => navigate(date ? { view: 'day', date } : { view: 'day' }),
  chat: (id: string) => navigate({ view: 'chat', id }),
  /** AF-018: the Projects tab, or one project's page. */
  project: (id?: string) => navigate(id ? { view: 'projects', id } : { view: 'projects' }),
  agent: (agentId: string) => navigate({ view: 'team', agentId }),
  /** B-057: a split's page under its agent. */
  split: (agentId: string, splitId: string) => navigate({ view: 'team', agentId, splitId }),
  /** A person's page in Team (F-52 people: 'per_…'). */
  person: (personId: string) => navigate({ view: 'team', personId }),
  settings: (section?: string) => navigate(section ? { view: 'settings', section } : { view: 'settings' }),
  tasks: (filter?: string, owner?: string) => navigate({ view: 'tasks', ...(filter ? { filter } : {}), ...(owner ? { owner } : {}) }),
};
