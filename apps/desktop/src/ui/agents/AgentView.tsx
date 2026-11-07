// AF-004 – the chat's agent view (like Claude Code's list of running agents): when several agents work in a chat – two
// main lanes, or an agent with its parts (B-057 splits) – one quiet block at the end of the messages instead of one live
// block each. A headline sums it up ("4 agents · 2 running · 1 waiting · 1 done"), then one 28 px row per agent: caret
// (only where it has parts), state icon (spinner, hourglass, check, warning, stop), name, what it does right now (one
// line, ellipsis), its steps ("4 steps") and its run time in fixed slots, and a reserved Stop cell. Parts are indented
// under their agent with a thin guide line and fold with the caret (open at first, so the parallel work shows without a
// click). Tool calls stay folded: a click on the row opens its steps below it (team/run-items.tsx, the newest few with
// "+N earlier steps"), a second click folds them again. Right-click: Open (the agent's page or the part's) · Stop.
// The tree and its words are agent-tree.ts; the Stop is agent-stop.ts (AF-012 may swap in its shared stop).
// Owns: this markup, which rows are folded or open (kept per row across remounts) and the one-second clock of the time
// slots. Never: polls, shows a step the runtime did not report, or moves a row when a state, step or time arrives.

import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import type { Message } from '../../shared/model/chat.ts';
import type { SplitGroupView } from '../../shared/model/splits.ts';
import { Icon, Spinner } from '../lib/ui.tsx';
import type { IconName } from '../lib/icons.tsx';
import type { MenuSection } from '../lib/popover.tsx';
import { useContextMenu } from '../lib/context-menu.tsx';
import { activity, agentName } from '../lib/store.ts';
import { can } from '../lib/session.ts';
import { go } from '../lib/router.ts';
import { modelShortName } from '../lib/model-name.ts';
import { RunItemList, holdRunsTopic, useRunItems } from '../team/run-items.tsx';
import { stepItems } from '../team/step-view.ts';
import { SplitStepRows } from '../splits/SplitRows.tsx';
import { ensureModelNames } from '../splits/split-model.ts';
import {
  STATE_LABEL, buildAgentTree, collapsedActivity, countStates, elapsedShort, headline, journalSteps, stepsLabel,
} from './agent-tree.ts';
import type { AgentNode, AgentState } from './agent-tree.ts';
import { stopAction } from './agent-stop.ts';

/** Steps an open row shows before "+N earlier steps" while its run works (as many as the live block). */
const ROW_STEPS = 6;
const KEEP = 200;

/** Rows the person folded (parents start open) and rows whose steps they opened (start folded): per row key. */
const folded = signal<ReadonlySet<string>>(new Set());
const stepsOpen = signal<ReadonlySet<string>>(new Set());

function flip(store: typeof folded, key: string): void {
  const next = new Set(store.peek());
  if (next.has(key)) next.delete(key); else next.add(key);
  if (next.size > KEEP) next.delete(next.values().next().value!);
  store.value = next;
}

// One clock for every time slot while any of them counts (no timer while nothing runs).
const clock = signal(Date.now());
let counting = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function useClock(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    if (counting++ === 0) { clock.value = Date.now(); timer = setInterval(() => { clock.value = Date.now(); }, 1000); }
    return () => { if (--counting === 0 && timer) { clearInterval(timer); timer = undefined; } };
  }, [active]);
}

const ICONS: Record<Exclude<AgentState, 'running'>, IconName> = {
  waiting: 'hourglass-simple', done: 'check-circle', failed: 'warning-circle', stopped: 'stop-circle',
};

function StateIcon(props: { state: AgentState }) {
  const label = STATE_LABEL[props.state];
  return (
    <span class={`agents-state ${props.state}`} title={label}>
      {props.state === 'running' ? <Spinner size={12} label={label} /> : <Icon name={ICONS[props.state]} size={14} title={label} />}
    </span>
  );
}

/** The run time in its fixed slot: counting while the row has started and not ended. */
function Elapsed(props: { node: AgentNode }) {
  const { startedAt, endedAt } = props.node;
  const counts = startedAt !== undefined && endedAt === undefined;
  useClock(counts);
  const text = elapsedShort(startedAt, endedAt, counts ? Math.max(clock.value, Date.now()) : 0);
  return <span class="agents-row-time tabular" aria-label={text ? `Run time ${text}` : undefined}>{text}</span>;
}

function rowMenu(node: AgentNode, stop: (() => Promise<void>) | undefined): MenuSection[] {
  const open = node.split ? () => go.split(node.agentId, node.split!.id) : () => go.agent(node.agentId);
  return [{ items: [
    { label: 'Open', onSelect: open },
    ...(stop ? [{ label: 'Stop', danger: true, onSelect: () => void stop() }] : []),
  ] }];
}

/** A row's steps below it: a main run's from its row (the journal on "+N earlier steps"), a part's from the journal. */
function RowSteps(props: { node: AgentNode; journal: ReturnType<typeof useRunItems>; onEarlier?: () => void }) {
  const { node, journal } = props;
  const rich = journal.items?.length ? journal.items : null;
  if (node.kind === 'split') {
    if (journal.error) return <p class="agents-row-note error">{journal.error}</p>;
    if (!journal.items) return <span class="agents-row-loading"><Spinner size={14} /></span>;
    if (!journal.items.length) return <p class="agents-row-note">{node.live ? 'No steps yet' : 'No steps recorded'}</p>;
  }
  const items = rich ?? stepItems(node.runId!, node.liveSteps ?? []);
  if (!items.length) return <p class="agents-row-note">No steps yet</p>;
  return (
    <SplitStepRows.Provider value={false /* the parts are rows of this view already */}>
      <RunItemList items={items} live={node.live} window={node.live ? ROW_STEPS : undefined} earlier={rich ? 0 : node.more}
        onEarlier={props.onEarlier} class="agents-steps" />
    </SplitStepRows.Provider>
  );
}

function AgentRow(props: { node: AgentNode; depth: number }) {
  const { node, depth } = props;
  const parent = node.children.length > 0;
  const open = parent && !folded.value.has(node.key);
  const steps = stepsOpen.value.has(node.key);
  const runId = node.runId ?? '';
  const readable = can('runs.items');
  // A part's steps are read from the start (their count is the row's "N steps"); a main run's row carries its own.
  const [earlier, setEarlier] = useState(false);
  const journal = useRunItems(runId, node.agentId, { enabled: readable && !!node.runId && (node.kind === 'split' || earlier), live: node.live });
  const count = node.kind === 'split' ? (journal.items ? journalSteps(journal.items) : undefined) : node.steps;
  const stop = stopAction(node.stop);
  const [stopping, setStopping] = useState(false);
  const menu = useContextMenu(() => rowMenu(node, stop));
  const line = parent && !open ? collapsedActivity(node) : node.activity;
  const tip = [node.title, STATE_LABEL[node.state], node.model].filter(Boolean).join(' · ');
  const main = (
    <>
      <StateIcon state={node.state} />
      <span class="agents-row-name">{node.title}</span>
      <span class="agents-row-activity">{line}</span>
      <span class="agents-row-steps tabular">{stepsLabel(count)}</span>
    </>
  );
  return (
    <li class={`agents-item kind-${node.kind} state-${node.state}`} data-key={node.key}>
      <div class="agents-row" style={{ '--depth': String(depth) }} {...menu}>
        <span class="agents-row-caret">
          {parent && (
            <button type="button" class="agents-caret" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} the parts of ${node.title}`} onClick={() => flip(folded, node.key)}>
              <Icon name={open ? 'caret-down' : 'caret-right'} size={12} />
            </button>
          )}
        </span>
        {node.runId ? (
          <button type="button" class="agents-row-main" aria-expanded={steps} title={tip} onClick={() => flip(stepsOpen, node.key)}>{main}</button>
        ) : <span class="agents-row-main" title={tip}>{main}</span>}
        <Elapsed node={node} />
        <span class="agents-row-stop">
          {stop && (
            <button type="button" class="agents-stop" title="Stop" aria-label={`Stop ${node.title}`} aria-busy={stopping || undefined}
              disabled={stopping} onClick={() => { setStopping(true); void stop().finally(() => setStopping(false)); }}>
              <span class="agents-stop-square" aria-hidden="true" />
            </button>
          )}
        </span>
      </div>
      {steps && node.runId && (
        <div class="agents-row-body" style={{ '--depth': String(depth) }}>
          <RowSteps node={node} journal={journal} onEarlier={readable && !journal.error && node.kind !== 'split' ? () => setEarlier(true) : undefined} />
        </div>
      )}
      {open && (
        <ul class="agents-children" style={{ '--depth': String(depth) }} aria-label={`Parts of ${node.title}`}>
          {node.children.map((child) => <AgentRow key={child.key} node={child} depth={depth + 1} />)}
        </ul>
      )}
    </li>
  );
}

/** The agent view of these trees (AgentView builds them from a chat; tests and other places may pass their own). */
export function AgentTreeView(props: { nodes: AgentNode[] }) {
  const { nodes } = props;
  const counts = countStates(nodes);
  return (
    <section class="agents-view" data-tour="agent-view" aria-label="Agents at work">
      <div class="agents-view-head">
        <span class="agents-view-title">{headline(counts)}</span>
      </div>
      <ul class="agents-tree">
        {nodes.map((node) => <AgentRow key={node.key} node={node} depth={0} />)}
      </ul>
    </section>
  );
}

/** The chat's agents at work: its live rows and running split groups as one tree. */
export function AgentView(props: { runs: readonly Message[]; groups: readonly SplitGroupView[] }) {
  const nodes = buildAgentTree({ runs: props.runs, groups: props.groups, activity: activity.value, nameOf: agentName, modelOf: modelShortName });
  // While shown: the run streams of the agents with parts, so every part's change arrives as it happens.
  const holders = [...new Set(props.groups.map((group) => group.agentId))].sort().join(',');
  useEffect(() => {
    const undo = holders ? holders.split(',').map((agentId) => holdRunsTopic(agentId)) : [];
    return () => { for (const off of undo) off(); };
  }, [holders]);
  useEffect(ensureModelNames, []);
  return <AgentTreeView nodes={nodes} />;
}
