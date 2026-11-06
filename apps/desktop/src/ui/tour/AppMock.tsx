// B-055 Q5: the tour's example app – a filled stand-in for the real window, drawn from the CSS tokens
// only (it follows light and dark) and from no live component, store or call, so rebuilding the live
// UI never breaks it and it never touches live data. Rail, the chat sidebar with a few example chats,
// the header row with the feedback cell where the real one sits (right of the workspace cell, before
// the caption controls) and one example chat whose contact card shows private details (an e-mail and a
// phone number) and whose calendar card shows the problem the person reports (the calendar stays empty).
// The same drawing is the "screenshot" in the menu's thumbnail and in the paint-over editor.
// Everything is placed in scene units (scene-layout.ts); the player scales the whole scene.
// Example content by design (B-055 §4: the tour scene is explicitly example content).
// Owns: this drawing. Never: state, timing or anything of the live app.

import { memo } from 'preact/compat';
import { TourIcon, type TourIconName } from './icons.tsx';
import {
  CAPTION_W, FEEDBACK_CELL, HEADER_H, PRIVATE, RAIL_W, SCENE_H, SCENE_W, SHEET_X, SIDEBAR_W, WORKSPACE_CELL, type Rect,
} from './scene-layout.ts';

/** Absolute placement of a rect (scene units). */
export const place = (rect: Rect) => ({ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });

/** The feedback cell's look: idle, under the cursor, pressed, or open (its menu shows). */
export type CellLook = 'idle' | 'hot' | 'down' | 'open';

const CHATS: ReadonlyArray<{ title: string; time: string; av: number }> = [
  { title: 'Sales calls', time: '10:42', av: 1 },
  { title: 'Website launch', time: '09:15', av: 3 },
  { title: 'October invoices', time: 'Mon', av: 2 },
  { title: 'Hiring: designer', time: 'Mon', av: 4 },
  { title: 'Weekly report', time: 'Fri', av: 5 },
  { title: 'Supplier quotes', time: 'Thu', av: 0 },
];
const RAIL: ReadonlyArray<{ icon: TourIconName; y: number; on?: boolean }> = [
  { icon: 'house', y: 60 }, { icon: 'chat', y: 100, on: true }, { icon: 'tasks', y: 140 }, { icon: 'users', y: 180 },
];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

function Cell(props: { rect: Rect; icon: TourIconName; look?: CellLook; class?: string }) {
  return (
    <span class={`tour-cell look-${props.look ?? 'idle'}${props.class ? ` ${props.class}` : ''}`} style={place(props.rect)}>
      <TourIcon name={props.icon} size={18} />
    </span>
  );
}

function Frame(props: { cell: CellLook }) {
  return (
    <>
      <Cell rect={{ x: 10, y: 8, w: 32, h: 32 }} icon="sidebar" />
      {RAIL.map((item) => <Cell key={item.icon} rect={{ x: 10, y: item.y, w: 32, h: 32 }} icon={item.icon} look={item.on ? 'open' : 'idle'} />)}
      <Cell rect={{ x: 10, y: SCENE_H - 48, w: 32, h: 32 }} icon="gear" />
      <span class="tour-side-title" style={{ left: `${RAIL_W + 12}px`, top: '12px' }}>Chats</span>
      <Cell rect={{ x: RAIL_W + SIDEBAR_W - 42, y: 8, w: 32, h: 32 }} icon="plus" />
      {CHATS.map((chat, index) => (
        <span key={chat.title} class={`tour-chat-row${index === 0 ? ' current' : ''}`} style={place({ x: RAIL_W + 8, y: 56 + index * 40, w: SIDEBAR_W - 16, h: 36 })}>
          <span class={`tour-av av-${chat.av}`}>{chat.title[0]}</span>
          <span class="tour-chat-title">{chat.title}</span>
          <span class="tour-chat-time">{chat.time}</span>
        </span>
      ))}
      <span class="tour-av av-1 tour-head-av" style={{ left: `${SHEET_X + 16}px`, top: '13px' }}>M</span>
      <span class="tour-head-title" style={{ left: `${SHEET_X + 46}px`, top: '14px' }}>Sales calls</span>
      <Cell rect={FEEDBACK_CELL} icon="megaphone" look={props.cell} class="tour-feedback-cell" />
      <Cell rect={WORKSPACE_CELL} icon="browsers" />
      <span class="tour-caption-controls" style={place({ x: SCENE_W - CAPTION_W, y: 0, w: CAPTION_W, h: 32 })}>
        <TourIcon name="minus" size={12} /><TourIcon name="square" size={11} /><TourIcon name="x" size={13} />
      </span>
    </>
  );
}

function Chat() {
  return (
    <>
      <span class="tour-bubble" style={{ right: `${SCENE_W - 891}px`, top: '72px' }}>Can you book a call with Anna next week?</span>
      <span class="tour-av av-1 tour-msg-av" style={{ left: '331px', top: '128px' }}>M</span>
      <span class="tour-msg-name" style={{ left: '363px', top: '128px' }}>Mira <span class="tour-msg-time">10:42</span></span>
      <span class="tour-msg-text" style={{ left: '363px', top: '154px' }}>Booked for Tuesday at 10:00. Here is her contact:</span>
      <span class="tour-card" style={place(PRIVATE.card)}>
        <span class="tour-card-line strong" style={{ top: `${PRIVATE.email.y - PRIVATE.card.y - 20}px` }}>Anna Meyer</span>
        <span class="tour-card-line tour-private" data-private="email" style={{ top: `${PRIVATE.email.y - PRIVATE.card.y - 1}px` }}>anna.meyer@example.com</span>
        <span class="tour-card-line tour-private" data-private="phone" style={{ top: `${PRIVATE.phone.y - PRIVATE.card.y - 1}px` }}>+43 660 1234567</span>
      </span>
      <span class="tour-msg-text" style={{ left: '363px', top: '274px' }}>It is in your Google Calendar too.</span>
      <span class="tour-calendar" style={place({ x: 363, y: 306, w: 440, h: 118 })}>
        <span class="tour-calendar-head"><span class="tour-dot" />Google Calendar <span class="tour-muted">Connected</span></span>
        <span class="tour-calendar-days">
          {DAYS.map((day) => <span key={day} class="tour-calendar-day"><span class="tour-muted">{day}</span></span>)}
        </span>
        <span class="tour-calendar-empty">No events this week</span>
      </span>
      <span class="tour-composer" style={place({ x: 331, y: 512, w: 560, h: 68 })}>
        <span class="tour-muted tour-composer-text">Message Mira</span>
        <TourIcon name="plus" size={18} class="tour-composer-plus" />
        <TourIcon name="microphone" size={18} class="tour-composer-mic" />
        <span class="tour-composer-send"><TourIcon name="arrow-up" size={16} /></span>
      </span>
    </>
  );
}

/** The example app, `cell` the feedback cell's look (the screenshot draws it idle). */
export const AppMock = memo(function AppMock(props: { cell: CellLook }) {
  return (
    <div class="tour-app">
      <span class="tour-sheet" style={place({ x: SHEET_X, y: HEADER_H, w: SCENE_W - SHEET_X, h: SCENE_H - HEADER_H })} />
      <Frame cell={props.cell} />
      <Chat />
    </div>
  );
});
