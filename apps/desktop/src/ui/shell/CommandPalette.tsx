// Command palette (Ctrl/Cmd+K; search icon on mobile): chats (main chats and Team activity rooms, never
// the app-owned system chats), agents, Settings and actions (new chat, new task in this chat, My day, feedback, the
// feedback tour's replay "Watch how it works", "Set up team again" for the owner while a Manager exists, "Stop all
// agent work" / "Resume agent work"), and for the owner the projects (AF-018, palette-projects.ts: open one, a new session
// in one, Add project…). Actions this connection may not call are left out (shell/gates.ts
// paletteActions). Matching: a label that starts with or contains the query, then a hint; a loose subsequence only
// for 3+ characters starting at a word ("nwc" → New chat); the matched words are marked. The list keeps one
// height, so typing never resizes it.
// Phone: full screen with Back at the start of the search row.
// Owns: the palette dialog, ranking and keyboard navigation. Never: implements the actions' business logic.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Icon, IconButton, Dialog } from '../lib/ui.tsx';
import type { IconName } from '../lib/ui.tsx';
import { Marked } from '../lib/mark.tsx';
import { chatSection } from '../../shared/text/chat-sections.ts';
import { agents, conversations, isMobile } from '../lib/store.ts';
import { chatTitle } from '../lib/chat-face.tsx';
import { go, navigate } from '../lib/router.ts';
import { can, isOwner } from '../lib/session.ts';
import { visibleSections } from '../settings/sections.ts';
import { composerFill, newChatOpen, paletteOpen } from '../lib/shell-state.ts';
import { activeConversationId } from '../lib/store.ts';
import { DESTINATIONS } from '../lib/vocab.ts';
import { setupAgainAllowed, startSetupAgain } from '../onboarding/setup-again.ts';
import { paletteActions } from './gates.ts';
import type { PaletteActionId } from './gates.ts';
import { openFeedback } from './ProfileMenu.tsx';
import { openTour } from '../tour/open.ts';
import { startTour } from '../tour/spotlight.ts';
import { toggleSidebar } from './WindowBar.tsx';
import { resumeAllWork, stopAllWork, watchWorkStop, workStop } from './work-stop.ts';
import { comboLabel } from '../lib/hotkeys.ts';
import { bridge } from '../lib/platform.ts';
import { toastError } from '../lib/toasts.ts';
import { addAndOpenProject, openProjectPage, projectList, watchProjects } from '../lib/projects.ts'; // AF-018
import { PROJECTS_GROUP, projectEntries } from './palette-projects.ts';

interface Entry {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: IconName;
  run: () => void;
}

function buildEntries(): Entry[] {
  const chatId = activeConversationId.value;
  const allowed = paletteActions(chatId);
  const own: Array<Entry & { id: PaletteActionId }> = [
    { id: 'a:new-chat', group: 'Actions', label: 'New chat', icon: 'plus', run: () => { newChatOpen.value = {}; } },
    ...(chatId ? [{ id: 'a:new-task' as const, group: 'Actions', label: 'New task in this chat', icon: 'chat-text' as IconName, run: () => { composerFill.value = { conversationId: chatId, text: '/task ' }; /* only into an empty composer */ } }] : []),
    { id: 'a:day', group: 'Actions', label: DESTINATIONS.day, icon: 'sun', run: () => go.day() },
    ...(isMobile.value ? [] : [{ id: 'a:sidebar' as const, group: 'Actions', label: 'Toggle sidebar', icon: 'sidebar-simple' as IconName, run: toggleSidebar }]), // the phone stack has no sidebar
    { id: 'a:feedback', group: 'Actions', label: 'Feedback', icon: 'megaphone', run: openFeedback }, // not "Send": a build without a sender saves only
    // the emergency stop (no Stop in the chat): Stop while work may run, Resume while stopped
    ...(workStop.value?.stopped
      ? [{ id: 'a:work-resume' as const, group: 'Actions', label: 'Resume agent work', icon: 'arrow-clockwise' as IconName, run: () => { void resumeAllWork(); } }]
      : [{ id: 'a:work-stop' as const, group: 'Actions', label: 'Stop all agent work', icon: 'stop-circle' as IconName, run: () => { void stopAllWork(); } }]),
  ];
  const setup: Entry[] = setupAgainAllowed() // the same confirmed flow as Team's Add › Start setup again
    ? [{ id: 'a:setup', group: 'Actions', label: 'Set up team again', icon: 'users-three', run: () => { void startSetupAgain(); } }]
    : [];
  // B-055: the feedback tour's replay (ui/tour/TourDialog.tsx), also on Settings › Feedback
  const tour: Entry = { id: 'a:tour', group: 'Actions', label: 'Watch how it works', icon: 'play', run: openTour };
  // AF-002: the spotlight tour through the app (tour/spotlight.ts), also on Settings › General › Getting started
  const appTour: Entry[] = can('onboarding.start') ? [{ id: 'a:app-tour', group: 'Actions', label: 'Show the app tour', icon: 'lightbulb', run: () => startTour() }] : [];
  const actions: Entry[] = [
    ...own.filter((entry) => allowed.has(entry.id)),
    ...setup,
    tour,
    ...appTour,
  ];
  const chats: Entry[] = conversations.value
    .filter((chat) => !chat.archivedAt && chatSection(chat) !== 'system' && !chat.settings.anchorId) // threads open in their chat's side panel
    .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
    .map((chat) => ({
      id: `c:${chat.id}`, group: 'Chats', label: chatTitle(chat) || 'Untitled chat', hint: chatSection(chat) === 'team' ? 'Team activity' : undefined,
      icon: 'chat-circle', run: () => navigate({ view: 'chat', id: chat.id }),
    }));
  const agentEntries: Entry[] = agents.value
    .filter((agent) => !agent.archivedAt)
    .map((agent) => ({ id: `g:${agent.id}`, group: 'Agents', label: agent.name, hint: agent.role, icon: 'user', run: () => go.agent(agent.id) }));
  const settingsEntry: Entry = { id: 's:settings', group: 'Settings', label: 'Settings', hint: comboLabel('mod+,'), icon: 'gear-six', run: () => go.settings() };
  const pages: Entry[] = visibleSections(can).map((section) => ({ id: `s:${section.id}`, group: 'Settings', label: section.title, hint: 'Settings', icon: section.icon, run: () => go.settings(section.id) }));
  return [...actions, ...projects(), ...chats, ...agentEntries, settingsEntry, ...pages];
}

/** AF-018: the project entries with what they do (the new session's prompt is typed on the project's page). */
function projects(): Entry[] {
  const pick = bridge?.files.pickFolder;
  const add = async () => {
    try {
      const folder = await pick?.('project');
      if (folder) await addAndOpenProject(folder);
    } catch (error) { toastError(error, 'Could not add the project'); }
  };
  return projectEntries(projectList.value, { owner: isOwner(), canPick: !!pick }).map((entry) => ({
    id: entry.id, group: PROJECTS_GROUP, label: entry.label, hint: entry.hint,
    icon: (entry.kind === 'add' ? 'plus' : entry.kind === 'new-session' ? 'chat-circle' : 'folder') as IconName,
    run: entry.kind === 'add' ? () => { void add(); } : () => openProjectPage(entry.projectId!),
  }));
}

function score(entry: Entry, query: string): number {
  if (!query) return entry.group === 'Actions' ? 2 : entry.group === 'Chats' ? 1 : 0;
  const label = entry.label.toLowerCase();
  const words = label.split(/\s+/);
  if (label.startsWith(query)) return 10;
  if (words.some((word) => word.startsWith(query))) return 8;
  if (label.includes(query)) return 6;
  if (entry.hint?.toLowerCase().includes(query)) return 3;
  // loose subsequence match ("nwc" → "new chat"): 3+ characters, from a word that starts with the
  // first one – two letters scattered over a label ("la" in "Toggle sidebar") are no match
  const first = words.findIndex((word) => word.startsWith(query[0]));
  if (query.length < 3 || first < 0) return -1;
  let index = 0;
  for (const char of words.slice(first).join(' ')) if (char === query[index]) index++;
  return index === query.length ? 1 : -1;
}

export function CommandPalette() {
  const open = paletteOpen.value;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) watchWorkStop(); }, [open]); // the brake entry knows whether work is stopped
  useEffect(() => { if (open && isOwner()) watchProjects(); }, [open]); // AF-018
  const entries = useMemo(() => (open ? buildEntries() : []), [open, workStop.value?.stopped, projectList.value]);
  const q = query.trim().toLowerCase();
  const results = entries
    .map((entry) => ({ entry, s: score(entry, q) }))
    .filter((item) => item.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, q ? 40 : 14)
    .map((item) => item.entry);

  // The query is cleared when the palette closes, never after it opens: an effect after opening
  // could land after the first typed characters and wipe them.
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
    else { setQuery(''); setActive(0); }
  }, [open]);
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const close = () => { paletteOpen.value = false; };
  const runEntry = (entry: Entry | undefined) => { if (!entry) return; close(); entry.run(); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((active + 1) % Math.max(1, results.length)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((active - 1 + results.length) % Math.max(1, results.length)); }
    else if (event.key === 'Enter') { event.preventDefault(); runEntry(results[active]); }
  };

  let lastGroup = '';
  return (
    <Dialog open={open} onClose={close} class="palette" width={560}>
      <div class="palette-search">
        {isMobile.value ? <IconButton icon="arrow-left" label="Close" iconSize={20} class="palette-back" onClick={close} /> : <Icon name="magnifying-glass" size={18} />}
        <input ref={inputRef} class="palette-input" placeholder="Search" value={query} aria-label="Search commands"
          role="combobox" aria-expanded="true" aria-controls="palette-list"
          onInput={(event) => setQuery((event.target as HTMLInputElement).value)} onKeyDown={onKeyDown} />
      </div>
      <div class="palette-list" id="palette-list" role="listbox" ref={listRef}>
        {results.map((entry, index) => {
          const header = entry.group !== lastGroup ? entry.group : null;
          lastGroup = entry.group;
          return (
            <div key={entry.id}>
              {header && <div class="menu-title">{header}</div>}
              <button type="button" role="option" aria-selected={index === active} class="palette-row"
                onMouseMove={() => { if (index !== active) setActive(index); }} onClick={() => runEntry(entry)}>
                <Icon name={entry.icon} size={17} />
                <span class="palette-label"><Marked text={entry.label} query={q} /></span>
                {entry.hint && <span class="menu-hint">{entry.hint}</span>}
              </button>
            </div>
          );
        })}
        {!results.length && <p class="empty-state palette-empty">No results</p>}
      </div>
    </Dialog>
  );
}
