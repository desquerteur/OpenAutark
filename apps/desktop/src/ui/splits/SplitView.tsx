// A split's page (B-057 S18 c, #/team/<agentId>/split/<splitId>): the frame's header (lib/header.tsx) with a Back cell to
// the agent and the part's name ("<Agent> · Part 3 of 5") as its dropdown (split-menu.ts: Stop while it runs – the
// same menu as a right click on any split row), then "#3 title" with its status icon, the facts in fixed rows (status,
// model · effort, time, cost and tokens, the parts it waited for, the group's goal, last why it failed or stopped; a
// fact without a value keeps its row with a muted word, a part at work shows when it started and the model its live
// activity names), the brief as a disclosure (closed: its first line) and the split's own steps live (team/run-items.tsx,
// the parent agent's run stream). A part's own branch is the agent's to merge or discard in its follow-up – no cell here.
// Read with splits.get (again after a reconnect or a Stop); the store (split-model.ts) keeps it current, with the agent's
// run stream held while the page is shown.
// Owns: this page. Never: invents a model, cost or step.

import { useEffect, useState } from 'preact/hooks';
import type { SplitGroupView, SplitView as Split } from '../../shared/model/splits.ts';
import { runCostText } from '../../shared/text/run-cost.ts';
import { EmptyState, Icon, Spinner } from '../lib/ui.tsx';
import { Header, backCell } from '../lib/header.tsx';
import { useContextMenu } from '../lib/context-menu.tsx';
import { keptPage } from '../lib/kept-page.ts';
import { RpcError, errorText, rpc } from '../lib/rpc.ts';
import { activity, agentName } from '../lib/store.ts';
import { go } from '../lib/router.ts';
import { modelShortName } from '../lib/model-name.ts';
import { time as clockTime } from '../lib/format.ts';
import { RunItemList, holdRunsTopic, useRunItems } from '../team/run-items.tsx';
import { SplitIcon } from './SplitRows.tsx';
import { TitleMenu } from '../team/TitleMenu.tsx';
import { splitMenu } from './split-menu.ts';
import { applyGroup, ensureModelNames, findSplit } from './split-model.ts';
import { SPLIT_STATUS_LABEL, elapsedText, isSettled, liveOfSplit, partLabel, partOf, splitModelText, tokensText } from './split-text.ts';

/** Reads a split's group into the store; the error, if any (not_found = it is gone). */
function readSplit(splitId: string): Promise<unknown> {
  return rpc.call('splits.get', { id: splitId }).then(({ group }) => { applyGroup(group); });
}

/**
 * The split from the store, read once (and after every reconnect) with splits.get; while shown it holds the agent's
 * run stream where this connection may (split.upserted: a waiting part that starts or is stopped shows at once).
 */
function useSplit(splitId: string, agentId: string): { found: { split: Split; group: SplitGroupView } | undefined; missing: boolean; error: string | null } {
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => readSplit(splitId)
      .then(() => { if (alive) { setMissing(false); setError(null); } })
      .catch((err) => {
        if (!alive) return;
        if (err instanceof RpcError && err.code === 'not_found') setMissing(true);
        else setError(errorText(err));
      });
    const release = holdRunsTopic(agentId); // before the read: no event falls between the two
    void load();
    const off = rpc.onOpen(() => { void load(); });
    return () => { alive = false; off(); release(); };
  }, [splitId, agentId]);
  return { found: findSplit(splitId), missing, error };
}

export function SplitView(props: { agentId: string; splitId: string }) {
  const { agentId, splitId } = props;
  const { found, missing, error } = useSplit(splitId, agentId);
  const split = found?.split;
  const menu = useContextMenu(() => (split ? splitMenu(split) : []));
  const title = split ? `${agentName(agentId)} · ${partOf(split)}` : agentName(agentId);
  return (
    <div class="agent-view split-view">
      <Header zone="main" class="split-header" lead={backCell(() => go.agent(agentId))} title={split ? <TitleMenu name={title} sections={() => splitMenu(split)} /> : title} />
      <div class="agent-scroll" {...keptPage}>
        <div class="agent-column" {...menu}>
          {found
            ? <SplitPage split={found.split} group={found.group} />
            : missing ? <EmptyState>This split no longer exists.</EmptyState> : error ? <p class="run-error">{error}</p> : <Spinner />}
        </div>
      </div>
    </div>
  );
}

function SplitPage(props: { split: Split; group: SplitGroupView }) {
  const { split, group } = props;
  const run = split.run;
  const settled = isSettled(split.status);
  useEffect(ensureModelNames, []);
  const model = splitModelText(split, modelShortName, split.status === 'running' ? liveOfSplit(activity.value, split.id) : undefined)
    || `Same as ${agentName(split.agentId)}`;
  const started = split.startedAt ?? run?.startedAt;
  // ended: how long it took; still at work: when it started (a duration would stand still – no ticking clock here)
  const time = settled ? elapsedText(started, split.endedAt ?? run?.endedAt) : started ? `Started ${clockTime(started)}` : '';
  const cost = [run ? runCostText(run) : '', tokensText(run)].filter(Boolean).join(' · ');
  /** A fact without a value yet keeps its row with a muted word (no blank row). */
  const none = (text: string) => <span class="split-fact-none">{text}</span>;
  return (
    <>
      <div class="split-page-title">
        <SplitIcon status={split.status} />
        <h3 class="split-page-name">{partLabel(split)}</h3>
      </div>
      <dl class="agent-facts split-facts">
        <div><dt>Status</dt><dd>{SPLIT_STATUS_LABEL[split.status]}{split.runs > 1 ? ` · attempt ${split.runs}` : ''}</dd></div>
        <div><dt>Model</dt><dd class="tabular">{model}</dd></div>
        <div><dt>Time</dt><dd class="tabular">{time || none('Not started')}</dd></div>
        <div><dt>Cost</dt><dd class="tabular">{cost || none(settled ? 'None' : 'None yet')}</dd></div>
        {split.after.length > 0 && <div><dt>After</dt><dd>{split.after.map((idx) => `#${idx}`).join(', ')}</dd></div>}
        <div><dt>Goal</dt><dd>{group.goal}</dd></div>
        {split.error && ( // last: a part that ends (Stop) adds this row below the others – nothing above it moves
          <div><dt>{split.status === 'failed' ? 'Error' : 'Reason'}</dt><dd class={`split-fact-why status-${split.status}`}>{split.error}</dd></div>
        )}
      </dl>
      <Brief brief={split.brief} returns={split.returns} />
      <section class="split-page-steps" aria-label="Steps">
        <h3 class="agent-section-title">Steps</h3>
        {run ? <Steps runId={run.id} agentId={split.agentId} live={split.status === 'running'} /> : <EmptyState>{SPLIT_STATUS_LABEL[split.status]}</EmptyState>}
      </section>
    </>
  );
}

/** The brief: closed, its first line; open, all of it (and what the part should return). */
function Brief(props: { brief: string; returns?: string }) {
  const [open, setOpen] = useState(false);
  const first = props.brief.split('\n').find((line) => line.trim()) ?? '';
  return (
    <div class="split-brief">
      <button type="button" class="split-brief-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'caret-down' : 'caret-right'} size={12} />
        <span class="split-brief-label">Brief</span>
        <span class="split-brief-first">{open ? '' : first}</span>
      </button>
      {open && (
        <div class="split-brief-body">
          <p class="split-brief-text">{props.brief}</p>
          {props.returns && <p class="split-brief-text"><span class="split-brief-label">Returns</span> {props.returns}</p>}
        </div>
      )}
    </div>
  );
}

function Steps(props: { runId: string; agentId: string; live: boolean }) {
  const { items, error } = useRunItems(props.runId, props.agentId, { enabled: true, live: props.live });
  if (error) return <p class="run-error">{error}</p>;
  if (!items) return <div class="run-loading"><Spinner size={14} /></div>;
  return <RunItemList items={items} live={props.live} class="split-page-items" />;
}
