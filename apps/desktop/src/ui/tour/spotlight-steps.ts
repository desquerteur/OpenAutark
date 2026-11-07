// AF-002: the app tour's steps and the first-visit hints (spotlight-model.ts types, spotlight.ts runs them). Targets are
// the agreed `data-tour` names (docs: .claude/agents/autark-developer.md), with stable selectors of today's markup after
// them where an element has no name yet (the Call cell, the side pane, the Apps page). Steps for features other builds
// add – the composer's queue, start/stop, the permission mode, personality, appearance – stay in the list: where their
// element is missing the tour skips them silently. Every text is one or two sentences and says what a part is for.
// Owns: the steps, their order, texts and places. Never: runs or draws them.

import type { AreaHint, TourStepDef } from './spotlight-model.ts';

const tour = (name: string) => `[data-tour="${name}"]`;
/** A tab of the phone layout's tab bar (shell/MobileShell.tsx). */
const phoneTab = (key: string) => `.tab-bar [data-tab="${key}"]`;
/** A Settings page's row in the Settings nav. */
const navPage = (page: string) => `.settings-nav [data-page="${page}"]`;

/** The whole app, in the order a newcomer meets it. */
export const TOUR_STEPS: readonly TourStepDef[] = [
  {
    id: 'welcome', targets: [], title: 'Welcome to Autark',
    text: 'This short tour shows where everything is. Use the arrow keys or the buttons, and leave whenever you like.',
  },
  {
    id: 'rail', targets: ['nav.rail', 'nav.tab-bar'], title: 'The four places',
    text: 'My day, Work, Chats and Team are the four places of the app. Your profile and the settings sit at the bottom.',
  },
  {
    id: 'sidebar', targets: [tour('sidebar')], place: { kind: 'route', route: { view: 'chats' } }, title: 'Sidebar',
    text: 'It lists what belongs to the place you are in – here your chats. Ctrl+B hides and shows it.',
  },
  {
    id: 'chat-list', targets: [tour('chat-list')], place: { kind: 'route', route: { view: 'chats' } }, area: 'chats', title: 'Chats',
    text: 'A chat is a place to talk with one or more agents. Your Manager is already here; New chat starts another.',
  },
  {
    id: 'composer', targets: [tour('composer')], place: { kind: 'manager-chat' }, area: 'chat', title: 'Message field',
    text: 'Write what you need, like to a colleague. The + attaches files, turns a message into a task or hands over a secret.',
  },
  {
    id: 'composer-send', targets: [tour('composer-send')], place: { kind: 'manager-chat' }, title: 'Send',
    text: 'Sends your message (Enter). A right click sends it as important, silently or at a time you choose.',
  },
  {
    id: 'composer-queue', targets: [tour('composer-queue')], place: { kind: 'manager-chat' }, title: 'Queue',
    text: 'While an agent is still working, new messages wait here. They go out one after another.',
  },
  {
    id: 'run-stop', targets: [tour('run-stop')], place: { kind: 'manager-chat' }, title: 'Start and stop',
    text: 'Stops what the agent is doing right now. Start it again whenever you like.',
  },
  {
    id: 'permission-mode', targets: [tour('permission-mode')], place: { kind: 'manager-chat' }, title: 'Permissions',
    text: 'Choose how freely agents may act before they ask you.',
  },
  {
    id: 'call-button', targets: [tour('call-button'), '.chat-header [data-cell="call"] button'], place: { kind: 'manager-chat' }, title: 'Calls',
    text: 'Talk with the agent by voice, like a phone call. It listens and answers out loud.',
  },
  {
    id: 'side-panel', targets: [tour('side-panel'), '#workspace'], place: { kind: 'pane' }, area: 'pane', title: 'Side panel',
    text: 'Your space beside the chat: My day, Work, Notes, Media, Files and a real browser, each in its own tab. A new tab lists them all.',
  },
  {
    id: 'my-day', targets: [tour('my-day'), phoneTab('day')], place: { kind: 'route', route: { view: 'day' } }, area: 'day', title: 'My day',
    text: 'The few things only you can do, what you handed off and your calendar. Agents put questions for you here.',
  },
  {
    id: 'tasks', targets: [tour('tasks'), phoneTab('tasks')], place: { kind: 'route', route: { view: 'tasks' } }, area: 'tasks', title: 'Work',
    text: 'Every task your agents work on, with its state and result. Whoever owns a task works on it until it is done.',
  },
  {
    id: 'agent-create', targets: [tour('agent-create'), '.sidebar [data-cell="add"]'], place: { kind: 'route', route: { view: 'team' } }, area: 'team', title: 'Add agents',
    text: 'Hire a new agent with its own job, or add a person. Your Manager can also hire colleagues for you.',
  },
  {
    id: 'agent-view', targets: [tour('agent-view'), '.agent-view'], place: { kind: 'manager-page' }, area: 'agent', title: 'An agent\'s page',
    text: 'Each agent has its own page: instructions, model, skills, its work and its own browser.',
  },
  {
    id: 'settings', targets: [tour('settings')], title: 'Profile and settings',
    text: 'Your profile, other companies and the settings are behind your picture (Ctrl+,).',
  },
  {
    id: 'accounts', targets: [tour('accounts')], place: { kind: 'route', route: { view: 'settings', section: 'models' } }, area: 'settings', title: 'Models and accounts',
    text: 'Connect AI plans, API keys or a local server here, and choose which model does what.',
  },
  {
    id: 'connectors', targets: [tour('connectors'), navPage('apps')], place: { kind: 'route', route: { view: 'settings', section: 'apps' } }, area: 'apps', title: 'Connectors',
    text: 'Connect GitHub, your mail and MCP servers, so agents can work with your tools.',
  },
  {
    id: 'skills', targets: [tour('skills')], place: { kind: 'route', route: { view: 'settings', section: 'skills' } }, area: 'skills', title: 'Skills and memory',
    text: 'What your agents know and can do, as plain files you can read and change.',
  },
  {
    id: 'personality', targets: [tour('personality')], place: { kind: 'route', route: { view: 'settings' } }, title: 'Personality',
    text: 'Shape how your agents sound and behave with you.',
  },
  {
    id: 'appearance', targets: [tour('appearance')], place: { kind: 'route', route: { view: 'settings' } }, title: 'Appearance',
    text: 'Light, dark or your own look for the whole app.',
  },
  {
    id: 'feedback', targets: ['[data-cell="feedback"]'], title: 'Feedback',
    text: 'Tell the Autark team what works and what does not. Hold to speak, and paint over anything private.',
    extra: { label: 'Watch how', action: 'feedback-video' },
  },
  {
    id: 'end', targets: [], title: 'You are set',
    text: 'Your Manager is waiting in the chat. Settings › General › Getting started shows this tour again.',
  },
];

/** The short hint the first time an area opens (after the tour was closed or for what it did not reach). */
export const AREA_HINTS: readonly AreaHint[] = [
  { area: 'day', views: ['day', 'home'], step: { id: 'hint-day', targets: [tour('my-day'), phoneTab('day')], title: 'My day', text: 'The few things only you can do, what you handed off and your calendar.' } },
  { area: 'tasks', views: ['tasks'], step: { id: 'hint-tasks', targets: [tour('tasks'), phoneTab('tasks')], title: 'Work', text: 'Every task your agents work on, with its state and result.' } },
  { area: 'chats', views: ['chats'], step: { id: 'hint-chats', targets: [tour('chat-list')], title: 'Chats', text: 'Talk with one or more agents here; New chat starts another place to talk.' } },
  { area: 'chat', views: ['chat'], step: { id: 'hint-chat', targets: [tour('composer')], title: 'Message field', text: 'Write what you need, like to a colleague. Enter sends.' } },
  { area: 'team', views: ['team'], step: { id: 'hint-team', targets: [tour('agent-create'), '.sidebar [data-cell="add"]'], title: 'Your team', text: 'Add agents with their own jobs, or people. Click an agent to see its page.' } },
  { area: 'settings', views: ['settings'], page: 'models', step: { id: 'hint-settings', targets: [tour('accounts')], title: 'Models and accounts', text: 'Connect AI plans, API keys or a local server, and choose which model does what.' } },
  { area: 'apps', views: ['settings'], page: 'apps', step: { id: 'hint-apps', targets: [tour('connectors'), navPage('apps')], title: 'Connectors', text: 'Connect GitHub, mail and MCP servers, so agents can use your tools.' } },
  { area: 'skills', views: ['settings'], page: 'skills', step: { id: 'hint-skills', targets: [tour('skills')], title: 'Skills and memory', text: 'What your agents know and can do, as plain files.' } },
  { area: 'secrets', views: ['settings'], page: 'secrets', step: { id: 'hint-secrets', targets: [navPage('secrets')], title: 'Secrets', text: 'Passwords and keys your agents may use – they see a name, never the value.' } },
  { area: 'devices', views: ['settings'], page: 'devices', step: { id: 'hint-devices', targets: [navPage('devices')], title: 'Devices', text: 'Link your phone and your other PCs, so your team works everywhere.' } },
  { area: 'pane', views: 'pane', step: { id: 'hint-pane', targets: [tour('side-panel'), '#workspace'], title: 'Side panel', text: 'My day, Work, Notes, Media, Files and a browser, each in its own tab.' } },
];

/** The agreed `data-tour` names the steps use (a test checks the list). */
export const TOUR_NAMES = [
  'sidebar', 'chat-list', 'agent-create', 'tasks', 'composer', 'composer-send', 'composer-queue', 'run-stop', 'permission-mode',
  'side-panel', 'call-button', 'settings', 'accounts', 'connectors', 'personality', 'appearance', 'skills', 'agent-view',
] as const;
