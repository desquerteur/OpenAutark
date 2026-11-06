// The blocks under My day's list, today only, each left out while it is empty: Ahead today (`calendar`: the pane's column
// has no calendar beside it; events still ahead, a click opens the full My day), Chats that matter (important-chats.ts; a
// click opens the chat, at the waiting to-do's message) and Work (B-078: the report's top three lines, day-overview.ts
// dayReport – a sentence opens its task –, what the agents spent since last night, and "Open Work"). Beside a chat Work opens as the pane's tab, so the chat
// stays; a phone goes to the Work view. Every block shows only what this connection may read. Time windows move by
// themselves: everything is read at the later of the day, For-you and Work clocks.
// Owns: these blocks' markup. Never: ranks chats, decides what is stuck, or copies tasks.

import type { ComponentChildren } from 'preact';
import { useEffect, useId } from 'preact/hooks';
import { HUMAN_ID } from '../../shared/ids.ts';
import type { ConversationSummary } from '../../shared/model/chat.ts';
import { lastEvening } from '../../shared/model/day-settings.ts';
import type { SpendEntry } from '../../shared/model/security.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import { liveRuns, workingIds } from '../chat/live-text.ts';
import { ChatFace, chatTitle } from '../lib/chat-face.tsx';
import { briefing, dayClock, dayRange, dayZone } from '../lib/day-store.ts';
import { plainPreview } from '../lib/format.ts';
import { isPersonSession } from '../lib/people.ts';
import { go, navigate } from '../lib/router.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { activity, agentName, conversations, isMobile, settings, todoClock, todos } from '../lib/store.ts';
import { useAsync } from '../settings/controls.tsx';
import { chatRouteAllowed } from '../shell/gates.ts';
import { liveGroupsOf } from '../splits/split-model.ts';
import { doneTasks, ensureDone } from '../tasks/done-store.ts';
import { jumpToMessage, openTask, useWorkClock } from '../tasks/jump.ts';
import { WorkReport } from '../tasks/WorkRegions.tsx';
import { DAY_MS, REPORT_DAYS } from '../tasks/model.ts';
import { openPanel } from '../workspace/pages.ts';
import { briefingFor } from './day-briefing.ts';
import { clockOf } from './day-grid.ts';
import { dayReport, eventsAhead, OVERVIEW_LIMITS, spentText } from './day-overview.ts';
import { ensureCalendar, eventsOn, shownDate, today, watchSources } from './day-state.ts';
import { importantChats, type ImportantChat } from './important-chats.ts';

function Block(props: { heading: string; children: ComponentChildren }) {
  const id = useId();
  return (
    <section class="day-group day-over" aria-labelledby={id}>
      <h3 class="day-group-heading" id={id}>{props.heading}</h3>
      {props.children}
    </section>
  );
}

const openWork = () => { if (isMobile.peek()) go.tasks(); else openPanel({ kind: 'work' }); };

function AheadToday(props: { date: string; now: number }) {
  const tz = dayZone.value;
  useEffect(() => watchSources(), []);
  useEffect(() => { void ensureCalendar(props.date); }, [props.date]);
  const ahead = eventsAhead(eventsOn(props.date, tz).map((entry) => entry.event), props.now);
  if (!ahead.length) return null;
  const more = ahead.length - OVERVIEW_LIMITS.ahead;
  return (
    <Block heading="Ahead today">
      <ul class="day-over-list">
        {ahead.slice(0, OVERVIEW_LIMITS.ahead).map((event) => (
          <li key={event.id}>
            <button type="button" class="day-over-event" onClick={() => go.day()}>
              <time class="day-over-time tabular">{clockOf(event.startAt, tz)}</time>
              <span class="day-over-title">{event.title}</span>
            </button>
          </li>
        ))}
      </ul>
      {more > 0 && <button type="button" class="text-button day-over-more" onClick={() => go.day()}>{more} more today</button>}
    </Block>
  );
}

/** The chat's last message as one line ("You: …" for the person's own, the sender's name in groups). */
function previewOf(chat: ConversationSummary): string {
  const preview = chat.lastPreview;
  if (!preview) return chat.unread > 0 ? `${chat.unread} unread` : '';
  const text = plainPreview(preview.text, 120);
  if (preview.authorId === HUMAN_ID) return `You: ${text}`;
  const group = chat.members.filter((member) => member.leftAt === undefined).length > 2;
  return group && preview.authorId !== 'system' ? `${agentName(preview.authorId)}: ${text}` : text;
}

function ChatRow(props: { row: ImportantChat<ConversationSummary, TaskView> }) {
  const { chat, todo, signal } = props.row;
  const open = () => {
    if (todo?.messageId && todo.conversationId === chat.id) void jumpToMessage(chat.id, todo.messageId);
    else navigate({ view: 'chat', id: chat.id });
  };
  const line = props.row.reason ?? previewOf(chat);
  const important = (chat.importantUnread ?? 0) > 0;
  return (
    <li>
      <button type="button" class={`day-over-row${chat.unread > 0 ? ' unread' : ''}`} onClick={open}>
        <ChatFace chat={chat} size={32} />
        <span class="day-over-text">
          <span class="day-over-title">{chatTitle(chat)}</span>
          {line && <span class={`day-over-line${signal === 'waits' ? ' waits' : ''}`}>{line}</span>}
        </span>
        {chat.unread > 0 && <span class={`unread-badge tabular${important ? ' important' : ''}`} aria-label={`${chat.unread} unread${important ? ', important' : ''}`}>{chat.unread > 99 ? '99+' : chat.unread}</span>}
      </button>
    </li>
  );
}

function WorkBlock(props: { now: number; since: number }) {
  const { now, since } = props;
  useEffect(() => { void ensureDone({ since: now - REPORT_DAYS * DAY_MS }).catch(() => undefined); }, []); // not loaded: no lines yet
  const runs = activity.value.map((entry) => entry.runId).sort().join(' '); // money: read again when a run starts or ends, never polled
  const mayMoney = can('spend.list');
  const money = useAsync<SpendEntry[]>(() => (mayMoney ? rpc.call('spend.list', { since }) : Promise.resolve([])), [since, mayMoney, runs]);
  const spent = spentText(money.data ?? []);
  const lines = dayReport(doneTasks.value, now, { keepOwn: isPersonSession() });
  if (!lines.length && !spent) return null;
  return (
    <Block heading="Work">
      <WorkReport lines={lines} now={now} onSelect={(id) => { const task = doneTasks.value.find((entry) => entry.id === id); if (task) openTask(task); }} />
      {spent && <button type="button" class="day-over-work" onClick={openWork}><span class="day-over-work-text tabular">{spent} since last night</span></button>}
      <button type="button" class="text-button day-over-more" onClick={openWork}>Open Work</button>
    </Block>
  );
}

/** Who works in a chat, named as its header does: its live rows, then its running split groups (a split run has no row). */
const workingOf = (chat: Pick<ConversationSummary, 'id' | 'working' | 'live'>) => workingIds(chat, [
  ...liveRuns(chat), ...liveGroupsOf(chat.id).map((group) => ({ agentId: group.agentId, conversationId: chat.id, note: '' })),
]);

export function DayOverview(props: { calendar?: boolean }) {
  const workNow = useWorkClock();
  const now = Math.max(dayClock.value, todoClock.value, workNow);
  const date = today.value;
  if (shownDate.value !== date) return null; // another day of My day: these say what is now
  const tz = dayZone.value;
  const chats = chatRouteAllowed() ? importantChats(conversations.value, {
    todos: todos.value, briefing: briefingFor(briefing.value, date)?.chats, now, dayEnd: dayRange(date, tz).to, nameOf: agentName,
    workingOf,
  }) : [];
  return (
    <>
      {props.calendar && can('calendar.list') && <AheadToday date={date} now={now} />}
      {chats.length > 0 && <Block heading="Chats that matter"><ul class="day-over-list">{chats.map((row) => <ChatRow key={row.chat.id} row={row} />)}</ul></Block>}
      {can('tasks.list') && <WorkBlock now={now} since={lastEvening(now, tz, settings.value?.day?.workEnd)} />}
    </>
  );
}
