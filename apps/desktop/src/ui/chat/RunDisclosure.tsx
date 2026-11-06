// What the agent did for an answer (C5, D5): one muted line ABOVE an agent message that came from a
// run, right under its byline – "Worked 2 min · 6 steps", "Working · 3 steps" while the run still
// runs, "Thought for 12 s" for a run that only reasoned (run-line.ts) – collapsed by default; a
// click opens the run's compact step lines in place (team/run-items.tsx, the list of Team › agent ›
// Runs) and closes them again. Plain answers (no step, no reasoning) get no line. Right after the
// live block turned into this answer the items it held are the first list (useRunItems), so the
// line is there from the first frame and the body below it never moves. B-059 #74: on an answer whose items
// are not loaded yet (a reopened chat, after a restart) the line comes from its meta (run-line.ts lineFromMeta) and
// only swaps its text once they arrive – nor does a refused or empty list take a shown line away.
// B-075: the line and the list come from the row – meta.ms, meta.steps / meta.thought ("Worked 41 s · 6 steps") and
// meta.lines (its steps) – on every device that has the row; where this connection may call runs.items and the run is
// in this PC's journal, the list shows the richer journaled items instead (inputs, outputs, notes).
// Lazy: the items are read only once the message comes near the screen (one shared
// IntersectionObserver), then kept live while the run runs (useRunItems). A refusal (another PC's run, a phone
// without access) just leaves the row's own list.
// The line usually arrives after MessageList stuck to the end, and only this component renders
// it: when the list (`.message-scroller`) showed its end just before, the line keeps it there –
// otherwise the newest answer and its actions slip below the edge without a scroll or a pill.
// Owns: the line, its open state, the near-screen trigger and keeping the end in view when the
// line appears. Never: polls, reads runs that are not in the message's chat, or scrolls a list
// the person had scrolled away from its end.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Message } from '../../shared/model/chat.ts';
import { Icon } from '../lib/ui.tsx';
import { can } from '../lib/session.ts';
import { RunItemList, useRunItems } from '../team/run-items.tsx';
import { stepItems } from '../team/step-view.ts';
import { runSpan, showsEnd } from './run-summary.ts';
import { disclosureLine, earlierSteps, lineFromMeta } from './run-line.ts';

/** How far outside the visible part a message may be and still load its line. */
const NEAR_MARGIN = '400px 0px';

let observer: IntersectionObserver | null = null;
const waiting = new Map<Element, () => void>();

/** Calls `onNear` once when `element` comes near the screen (at once where there is no observer). */
function whenNear(element: Element, onNear: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') { onNear(); return () => undefined; }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const done = entry.isIntersecting ? waiting.get(entry.target) : undefined;
      if (!done) continue;
      waiting.delete(entry.target);
      observer?.unobserve(entry.target);
      done();
    }
  }, { rootMargin: NEAR_MARGIN });
  waiting.set(element, onNear);
  observer.observe(element);
  return () => { waiting.delete(element); observer?.unobserve(element); };
}

/** The message list's scroller when it shows its end right now, else null. */
function listAtEnd(element: Element | null): HTMLElement | null {
  const scroller = element?.closest<HTMLElement>('.message-scroller') ?? null;
  return scroller && showsEnd(scroller) ? scroller : null;
}

/** The disclosure for one agent message of a run; nothing for other messages. */
export function RunDisclosure(props: { message: Message }) {
  const { message } = props;
  if (message.authorKind !== 'agent' || !message.runId) return null;
  return <Disclosure message={message} runId={message.runId} />;
}

function Disclosure(props: { message: Message; runId: string }) {
  const { message, runId } = props;
  const anchor = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const element = anchor.current;
    if (!element || near) return;
    return whenNear(element, () => setNear(true));
  }, [near]);
  const live = message.state === 'streaming';
  const { items } = useRunItems(runId, message.authorId, { enabled: near && can('runs.items'), live });
  // B-075: the row's own line; an older answer without its time from the journaled items where they are here.
  const summary = (message.meta.ms === undefined && items ? disclosureLine(items, live, runSpan(items, message.createdAt)) : null) ?? lineFromMeta(message.meta);
  const journaled = Boolean(items?.length);
  // The first render with a line, before it is in the DOM: did the list show its end? (A line
  // there from the mount on – cached items – is placed by MessageList's own stick.)
  const shown = useRef(false);
  const keepEnd = useRef<HTMLElement | null>(null);
  if (summary && !shown.current) {
    shown.current = true;
    keepEnd.current = listAtEnd(anchor.current);
  }
  useLayoutEffect(() => {
    const scroller = keepEnd.current;
    keepEnd.current = null;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [summary !== null]);
  return (
    <div class="run-disclosure" ref={anchor}>
      {summary && (
        <button type="button" class={`run-disclosure-toggle${summary.live ? ' live' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'caret-down' : 'caret-right'} size={11} />
          <span>{summary.text}</span>
        </button>
      )}
      {summary && open && <RunItemList items={journaled ? items! : stepItems(runId, message.meta.lines ?? [])} live={live} earlier={journaled ? 0 : earlierSteps(message.meta)} />}
    </div>
  );
}
