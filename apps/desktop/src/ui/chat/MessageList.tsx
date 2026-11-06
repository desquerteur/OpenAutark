// Message list with simple windowing: only the newest WINDOW messages are rendered; scrolling
// near the top widens the window and loads older pages; the scroll position stays anchored.
// Sticks to the bottom while new messages or row updates arrive if the user was at the bottom – also when
// the list or its content changes size (a side panel opening, an image loading).
// Bursts of status lines collapse into one expandable line; a jump to a line inside a collapsed
// burst lands on the burst. The "New messages" divider sits before the first new message since the
// start ChatView captured; "↓ N new" counts new messages below the visible part and goes to the newest. D5: live work
// (B-075: the chat's rows that still stream, each with its run's live values, and running split groups) always
// renders after all rows (PendingWork, ordered by start) – the newest activity is at the bottom –,
// and each finished run's line "Worked … · N steps" sits on one message only (message-rows.ts runLineIds).
// Owns: windowing, scroll anchoring, the divider's place and the pill count.
// Never: message markup (MessageItem), the grouping into rows (message-rows.ts) or what counts as new (catch-up.ts).

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { historyComplete, loadOlder, messagesFor } from '../lib/store.ts';
import { focusMessage } from '../lib/shell-state.ts';
import { Spinner } from '../lib/ui.tsx';
import { MessageItem, StatusGroup } from './MessageItem.tsx';
import { catchUp, isNew, type CatchUpStart } from './catch-up.ts';
import { burstLineFor, groupRows, isLiveWork, liveRunIds, rowHas, runLineIds, type Row } from './message-rows.ts';
import { NewPill, UnreadDivider } from './UnreadDivider.tsx';
import { PendingWork } from './WorkingMessage.tsx';
import { CallTranscript } from './call/CallTranscript.tsx';

const WINDOW = 80; // rendered messages initially
const STEP = 40; // widened by this when scrolling up
const MAX_WINDOW = 400; // trimmed back when the user returns to the bottom

/** The element a message is found under: its own, or its collapsed status burst's (message-rows.ts). */
function elementFor(root: HTMLElement, rows: Row[], messageId: string): Element | null {
  const find = (id: string) => root.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
  const line = burstLineFor(rows, messageId);
  return find(messageId) ?? (line ? find(line) : null);
}

export function MessageList(props: { conversationId: string; loading: boolean; start?: CatchUpStart | null }) {
  const { conversationId } = props;
  const list = messagesFor(conversationId).value;
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  /** scrollTop at the last scroll event: only a move up (the person, or a jump) leaves the bottom. */
  const lastTop = useRef(0);
  /** The scroller's size as the resize observer last saw it ("w x h"). */
  const box = useRef('');
  const anchor = useRef<{ height: number; top: number } | null>(null);
  /** Messages up to this seq were on screen: the pill counts only newer ones. */
  const seen = useRef(0);
  const [below, setBelow] = useState(0);
  const [windowSize, setWindowSize] = useState(WINDOW);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const start = Math.max(0, list.length - windowSize);
  const visible = list.slice(start);
  const rows = groupRows(visible);
  const runLines = runLineIds(visible, liveRunIds(list)); // D5: one "Worked …" line per run (B-075: a run still streaming has its block instead)
  const lastSeq = list.length ? list[list.length - 1].seq : 0;
  const info = catchUp(list, props.start);

  /** "↓ N new": new messages after `seen` whose top is below the visible part. */
  const measure = () => {
    const el = scroller.current;
    let count = 0;
    if (el && !atBottom.current) {
      const limit = el.getBoundingClientRect().bottom;
      for (let i = visible.length - 1; i >= 0 && visible[i].seq > seen.current; i--) {
        if (!isNew(visible[i], seen.current)) continue;
        const node = el.querySelector(`[data-message-id="${CSS.escape(visible[i].id)}"]`);
        if (!node) continue;
        if (node.getBoundingClientRect().top < limit) break;
        count++;
      }
    }
    if (count !== below) setBelow(count);
  };

  // Keep the viewport stable when content is prepended; stick to bottom otherwise.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (anchor.current) {
      el.scrollTop = el.scrollHeight - anchor.current.height + anchor.current.top;
      anchor.current = null;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
      seen.current = lastSeq;
    }
  });

  useLayoutEffect(measure);

  // A list at the newest message stays there when its box or its content changes size without a
  // render here – a side panel or the workspace pane narrowing the chat (taller lines), an image
  // loading: the browser keeps the offset (or its scroll anchor, a line in view), which would leave
  // the newest lines below the fold. The browser's own scroll event for such a change arrives
  // before the observer: onScroll leaves the "at the bottom" state alone while the box size differs
  // from the one it last saw (`box`), so it is the layout that moved, not the person.
  useEffect(() => {
    const el = scroller.current;
    const column = el?.firstElementChild;
    if (!el || !column) return;
    const stick = () => {
      box.current = `${el.clientWidth}x${el.clientHeight}`;
      if (atBottom.current && !anchor.current) el.scrollTop = el.scrollHeight;
    };
    const observer = new ResizeObserver(stick);
    observer.observe(el);
    observer.observe(column);
    return () => observer.disconnect();
  }, []);

  // Jump to a message requested by search/task links.
  useEffect(() => {
    const target = focusMessage.value;
    if (!target || target.conversationId !== conversationId || !list.length) return;
    const index = list.findIndex((message) => message.id === target.messageId);
    if (index === -1) return;
    if (index < start) { setWindowSize(list.length - index + 10); return; }
    requestAnimationFrame(() => {
      const root = scroller.current;
      const el = root ? elementFor(root, rows, target.messageId) : null;
      el?.scrollIntoView({ block: 'center' });
      el?.classList.add('flash');
      setTimeout(() => el?.classList.remove('flash'), 1600);
      atBottom.current = false;
      focusMessage.value = null;
    });
  }, [focusMessage.value, list.length, start]);

  const widen = async () => {
    const el = scroller.current;
    if (!el || loadingOlder) return;
    anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    if (start > 0) { setWindowSize(windowSize + STEP); return; }
    if (historyComplete.has(conversationId)) { anchor.current = null; return; }
    setLoadingOlder(true);
    try {
      const added = await loadOlder(conversationId);
      if (added) setWindowSize(windowSize + added);
      else anchor.current = null;
    } catch {
      anchor.current = null;
    } finally {
      setLoadingOlder(false);
    }
  };

  const toNewest = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = true;
    seen.current = lastSeq;
    el.scrollTop = el.scrollHeight;
    setBelow(0);
  };

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const up = el.scrollTop < lastTop.current - 1;
    lastTop.current = el.scrollTop;
    // the box changed size since the observer last saw it: the layout moved the offset, not the person
    if (atBottom.current && box.current && box.current !== `${el.clientWidth}x${el.clientHeight}`) { el.scrollTop = el.scrollHeight; return; }
    // Content that grew below (a live tool row, a streamed line) before the stick ran is no reason to
    // leave the bottom: only a move up does (wheel, keys, the scrollbar); near the end is the bottom again.
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (near) atBottom.current = true;
    else if (up) atBottom.current = false;
    else if (atBottom.current) { el.scrollTop = el.scrollHeight; return; }
    if (atBottom.current) seen.current = lastSeq;
    if (el.scrollTop < 240) void widen();
    if (atBottom.current && windowSize > MAX_WINDOW) setWindowSize(WINDOW);
    measure();
  };

  const nodes: VNode[] = [];
  const divider = () => <UnreadDivider key="unread-divider" count={info!.count} />;
  // The first new message may be a run's answer still being written: its live block is below every row.
  const dividerAtLive = Boolean(info) && visible.some((message) => message.id === info!.dividerBefore && isLiveWork(message));
  for (const row of rows) {
    if (info && rowHas(row, info.dividerBefore)) nodes.push(divider());
    nodes.push(row.kind === 'call'
      ? <CallTranscript key={row.callId} messages={row.messages} runLines={runLines} />
      : row.kind === 'message'
      ? <MessageItem key={row.message.id} message={row.message} runLine={runLines.has(row.message.id)} />
      : <StatusGroup key={row.messages[0].id} messages={row.messages} />);
  }

  return (
    <div class="message-scroller" ref={scroller} onScroll={onScroll}>
      <div class="message-column" role="log" aria-live="polite" aria-relevant="additions">
        {loadingOlder && <div class="older-loading"><Spinner size={14} /></div>}
        {props.loading && <div class="older-loading"><Spinner size={16} /></div>}
        {nodes}
        {dividerAtLive && divider()}
        <PendingWork conversationId={conversationId} messages={list} />
        <NewPill count={below} onClick={toNewest} />
      </div>
    </div>
  );
}
