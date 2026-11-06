// Run items as the person sees them – shared by Team › agent › Runs (AgentRuns.tsx), the chat's
// live work block (chat/WorkingMessage.tsx) and the "Worked … · N steps" disclosure above an agent
// answer (chat/RunDisclosure.tsx), on the desktop and the phone. D5, like Codex: every step is one
// compact 24 px line – icon, verb, target (step-view.ts), a spinner while a call runs, red when it
// failed, a click opens its input and output; provider-visible reasoning summaries are muted
// "Thought · <headline>" lines (shimmering while written) – never invented thoughts; plans, errors
// and the final answer's branch ("Kept internal", "Posted quietly",
// "Posted") are one line each (run-steps.tsx); agent updates stay text. The chat's live block shows
// the newest few with "+N earlier steps" above them (`window`; B-075: `earlier` – the steps its row only counts, a
// button that asks for the run's journal where this connection may read it, `onEarlier`).
// Loading (useRunItems): runs.items once the view needs it, then live while the run runs – over
// `runs:<agentId>` where this connection may hold that stream ('manage'), otherwise by reading the
// items again when the agent's live activity note changes (at most every 2 s: splits, Team on a chat-only phone).
// B-075: the chat renders a run's steps from its row (step-view.ts stepItems) and reads the journal only on a click
// (the live block's earlier steps, a stopped run's steps, an answer's "Worked …" list) where this PC holds it.
// Live work is announced before its run is journaled, so a live run not found yet is an empty list.
// A finished run's items are kept until the next (re)connect (a chat opened again shows them
// without a call), and the latest list of a live view (a split, a live block opened to its journal) seeds the
// answer's disclosure (no jump from live to final); the subscription to `runs:<agentId>` is counted, so two views
// never cancel each other's.
// Owns: the list, the item loader and the counted runs subscription.
// Never: polls, or shows more than the runtime journaled (outputs are already truncated and
// secret-redacted there).

import { useEffect, useRef, useState } from 'preact/hooks';
import type { Run, RunItem } from '../../shared/model/runs.ts';
import type { Topic } from '../../shared/api/protocol.ts';
import { EmptyState, Icon, Spinner } from '../lib/ui.tsx';
import { RpcError, rpc, errorText } from '../lib/rpc.ts';
import { holds } from '../lib/session.ts';
import { activity } from '../lib/store.ts';
import { mergeItem } from '../chat/run-summary.ts';
import { runEntries } from './model.ts';
import { liveWindow, shownEntry } from './step-view.ts';
import { StepEntry, entryKey } from './run-steps.tsx';

export { ToolEntry } from './run-steps.tsx';

// ---------------------------------------------------------------- rendering (one line per item: run-steps.tsx)

/**
 * The run's items in order, each tool call with its result, as compact lines (D5). `live`: the run
 * still runs (spinners on open calls, the newest thought shimmers). `window`: show only the newest
 * that many, with "+N earlier steps" above them (the chat's live block); the newest stays at the bottom.
 * `earlier` (B-075): steps before these that only a count names (a row keeps its newest steps) – one line; with
 * `onEarlier` a button that asks for every step (the run's journal) and shows them all once they are the items.
 */
export function RunItemList(props: { items: RunItem[]; live?: boolean; window?: number; earlier?: number; onEarlier?: () => void; class?: string }) {
  const [all, setAll] = useState(false);
  const live = props.live === true;
  const entries = runEntries(props.items).filter(shownEntry);
  const earlier = props.earlier ?? 0;
  if (!entries.length) return props.window ? null : <EmptyState>Nothing recorded for this run.</EmptyState>;
  const { hidden, shown } = props.window ? liveWindow(entries, props.window, all) : { hidden: 0, shown: entries };
  const earlierText = `+${earlier} earlier ${earlier === 1 ? 'step' : 'steps'}`;
  const onEarlier = props.onEarlier;
  return (
    <ul class={`run-items${props.class ? ` ${props.class}` : ''}`}>
      {earlier > 0 && hidden === 0 && (
        <li class="run-item more">
          {onEarlier ? (
            <button type="button" class="run-item-head" aria-expanded={false} onClick={() => { setAll(true); onEarlier(); }}>
              <span class="run-item-icon" aria-hidden="true"><Icon name="caret-right" size={11} /></span>
              <span class="run-item-verb">{earlierText}</span>
            </button>
          ) : (
            <span class="run-item-head">
              <span class="run-item-icon" aria-hidden="true" />
              <span class="run-item-verb">{earlierText}</span>
            </span>
          )}
        </li>
      )}
      {(hidden > 0 || (all && props.window && entries.length > props.window)) && (
        <li class="run-item more">
          <button type="button" class="run-item-head" aria-expanded={all} onClick={() => setAll(!all)}>
            <span class="run-item-icon" aria-hidden="true"><Icon name={all ? 'caret-down' : 'caret-right'} size={11} /></span>
            <span class="run-item-verb">{all ? 'Show fewer steps' : `+${hidden} earlier ${hidden === 1 ? 'step' : 'steps'}`}</span>
          </button>
        </li>
      )}
      {shown.map((entry) => <StepEntry key={entryKey(entry)} entry={entry} live={live} />)}
    </ul>
  );
}

/** A run's items for the agent view: loads when shown, live while the run runs. */
export function RunItems(props: { run: Run }) {
  const { run } = props;
  const live = run.status === 'running' || run.status === 'queued';
  const { items, error } = useRunItems(run.id, run.agentId, { enabled: true, live });
  if (error) return <p class="run-error">{error}</p>;
  if (!items) return <div class="run-loading"><Spinner size={14} /></div>;
  return <RunItemList items={items} live={live} />;
}

// ---------------------------------------------------------------- loading

/** Finished runs' items of this connection (newest last); cleared on every (re)connect. */
const CACHE_MAX = 60; // about the answers of one chat page – run items can be large
const finished = new Map<string, RunItem[]>();
/** B-075: finished runs this connection may not read (another PC's run – its row carries its steps); cleared like `finished`. */
const unreadable = new Set<string>();
let cacheWatched = false;
/** Connections without the runs stream read a live run again at most this often (they get no item events). */
const REFRESH_GAP_MS = 2000;

/**
 * D5: the latest list a live view of a run held (the chat's live block). The final answer's
 * disclosure starts from it, so its "Worked … · N steps" line is there on its first render and
 * nothing moves when the live block turns into the answer; it still reads the final list once.
 */
const lastLive = new Map<string, RunItem[]>();
const LIVE_MAX = 20;

function cached(runId: string): RunItem[] | undefined {
  if (!cacheWatched) {
    cacheWatched = true;
    rpc.onOpen(() => { finished.clear(); lastLive.clear(); unreadable.clear(); }); // a restarted runtime may have settled effects since
  }
  return finished.get(runId);
}

function keepLive(runId: string, items: RunItem[]): void {
  lastLive.delete(runId);
  lastLive.set(runId, items);
  if (lastLive.size > LIVE_MAX) lastLive.delete(lastLive.keys().next().value!);
}

function remember(runId: string, items: RunItem[]): void {
  finished.delete(runId);
  finished.set(runId, items);
  if (finished.size > CACHE_MAX) finished.delete(finished.keys().next().value!);
}

const held = new Map<Topic, number>();

/** Subscribes `runs:<agentId>` for one more holder; the returned release unsubscribes after the last. */
export function holdRunsTopic(agentId: string): () => void {
  const topic: Topic = `runs:${agentId}`;
  const count = held.get(topic) ?? 0;
  held.set(topic, count + 1);
  if (!count) rpc.subscribe([topic]);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (held.get(topic) ?? 1) - 1;
    if (left > 0) held.set(topic, left);
    else { held.delete(topic); rpc.unsubscribe([topic]); }
  };
}

/**
 * Items of one run. `enabled` false loads nothing yet (the disclosure waits until it is near the
 * screen); `live` keeps them current. Items arriving before the first answer are already in it
 * (one ordered connection), so live items are merged only into a loaded list.
 */
export function useRunItems(runId: string, agentId: string, options: { enabled: boolean; live: boolean }): { items: RunItem[] | null; error: string | null } {
  const { enabled, live } = options;
  const [items, setItems] = useState<RunItem[] | null>(() => cached(runId) ?? lastLive.get(runId) ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (items && live) keepLive(runId, items); }, [items, live, runId]);
  const stream = holds('manage'); // may hold runs:<agentId> (scopes.ts) – else refresh on activity
  const note = activity.value.find((entry) => entry.runId === runId)?.note;
  const state = useRef({ alive: true, inflight: false, again: false, refused: false, last: 0, timer: 0 as ReturnType<typeof setTimeout> | 0, live, note });
  state.current.live = live;

  const load = () => {
    const s = state.current;
    if (s.refused) return; // this connection may not read the run (or it is gone): asking again changes nothing
    if (s.inflight) { s.again = true; return; }
    s.inflight = true;
    rpc.call('runs.items', { runId })
      .then((list) => {
        if (!s.alive) return;
        setItems(list);
        setError(null);
        if (!s.live) remember(runId, list);
      })
      .catch((err) => {
        // A live run the journal does not hold yet (its turn waits for the subconscious's look, up to 25 s): no steps so far, they come as they do for any live run.
        if (s.live && err instanceof RpcError && err.code === 'not_found') { if (s.alive) setItems((current) => current ?? []); return; }
        if (err instanceof RpcError && (err.code === 'forbidden' || err.code === 'not_found')) { s.refused = true; if (!s.live && unreadable.size < 500) unreadable.add(runId); }
        if (s.alive) setError(errorText(err));
      })
      .finally(() => {
        s.inflight = false;
        s.last = Date.now();
        if (s.again && s.alive) { s.again = false; load(); }
      });
  };

  useEffect(() => {
    const s = state.current;
    s.alive = true;
    return () => { s.alive = false; if (s.timer) clearTimeout(s.timer); s.timer = 0; };
  }, [runId]);

  // Subscribe first, then read: the server answers in order, so no item falls between the two.
  useEffect(() => {
    if (!enabled) return;
    const undo: Array<() => void> = [];
    if (live && stream) {
      undo.push(holdRunsTopic(agentId));
      undo.push(rpc.on('run.item', (item) => {
        if (item.runId === runId) setItems((current) => (current ? mergeItem(current, item) : current));
      }));
    }
    // Live → read now; finished → read once (also right after the run ended, for its final list).
    if (live || (!cached(runId) && !unreadable.has(runId))) load();
    if (live) undo.push(rpc.onOpen(() => load())); // items journaled while the connection was down
    return () => { for (const off of undo) off(); };
  }, [runId, agentId, enabled, live, stream]);

  // Without the runs stream: the agent's live note changes with each step – read the items again.
  useEffect(() => {
    const s = state.current;
    if (s.note === note) return;
    s.note = note;
    if (!enabled || !live || stream || !s.alive) return;
    const wait = s.last + REFRESH_GAP_MS - Date.now();
    if (wait <= 0) { load(); return; }
    if (!s.timer) s.timer = setTimeout(() => { s.timer = 0; if (s.alive) load(); }, wait);
  }, [note, enabled, live, stream]);

  return { items, error };
}
