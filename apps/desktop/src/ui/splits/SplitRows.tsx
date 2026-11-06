// Split rows (B-057 S18, like Codex's sub-agent rows): one fixed 24 px row per part – a 16 px status icon slot (a
// spinner while it runs), "#3 title" (ellipsis), the model · effort in a fixed slot at the right (what it runs on – the
// live activity's while it runs; a narrow row shows the effort alone, splits.css) and the duration in a
// fixed slot after it; a row click opens that split's own steps right below it (team/run-items.tsx, the parent
// agent's run stream). Used by the parent's step line "Split · 3 of 5 done" (SplitStep, in the chat's run item lists:
// the live block, "Worked … · N steps", the working popover), by the chat's one live block per running group
// (SplitLiveBlock: "<Agent> 3 of 5 parts working" over its rows, the live block's frame – it holds the agent's run
// stream while shown, where the connection may) and by an open run in Team › agent › Runs (RunSplits, below its
// steps – there SplitStepRows is false and the agents.split call stays an ordinary step line: a run's splits show once).
// Rows open below fixed rows only; nothing above them moves.
// Owns: this markup and which rows are open. Never: polls, or shows a step the runtime did not journal.

import { createContext } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { RunItem } from '../../shared/model/runs.ts';
import type { SplitGroupView, SplitStatus, SplitView } from '../../shared/model/splits.ts';
import { AgentAvatar, Icon, Spinner } from '../lib/ui.tsx';
import type { IconName } from '../lib/icons.tsx';
import { activity, agentName } from '../lib/store.ts';
import { useContextMenu } from '../lib/context-menu.tsx';
import { go } from '../lib/router.ts';
import { modelShortName } from '../lib/model-name.ts';
import { RunItemList, holdRunsTopic, useRunItems } from '../team/run-items.tsx';
import { ensureModelNames, groupsOfRun, watchSplits } from './split-model.ts';
import { splitMenu } from './split-menu.ts';
import {
  SPLIT_STATUS_LABEL, groupDone, groupForCall, groupWorking, isLiveGroup, liveOfSplit, partLabel, splitDuration, splitIconKind, splitModelParts,
} from './split-text.ts';
import type { SplitIconKind } from './split-text.ts';

/** Steps an open split row shows before "+N earlier steps" while it runs (as many as the live block). */
const ROW_STEPS = 6;

/**
 * Whether a run item list draws the parent's agents.split call as "Split · 3 of 5 done" with its rows (team/run-steps.tsx
 * StepEntry). False where the run's splits are listed below its steps anyway (Team › agent › Runs: RunSplits), so a run's
 * splits show once there and its call stays an ordinary step line ("Split into 3 parts").
 */
export const SplitStepRows = createContext(true);

const ICONS: Record<Exclude<SplitIconKind, 'running'>, IconName> = {
  waiting: 'hourglass-simple', done: 'check-circle', failed: 'warning-circle', stopped: 'stop-circle', skipped: 'arrow-right',
};

/** The fixed 16 px status slot: a spinner while the split runs, its state's icon otherwise. */
export function SplitIcon(props: { status: SplitStatus }) {
  const kind = splitIconKind(props.status);
  return (
    <span class={`split-icon ${kind}`} title={SPLIT_STATUS_LABEL[props.status]}>
      {kind === 'running' ? <Spinner size={12} label="Running" /> : <Icon name={ICONS[kind]} size={14} title={SPLIT_STATUS_LABEL[props.status]} />}
    </span>
  );
}

/** One part's row; open: its steps below it. */
function SplitRow(props: { split: SplitView; agentId: string; open: boolean; onToggle: () => void }) {
  const { split, open } = props;
  const parts = splitModelParts(split, modelShortName, split.status === 'running' ? liveOfSplit(activity.value, split.id) : undefined);
  const model = [parts.name, parts.effort].filter(Boolean).join(' · ');
  const menu = useContextMenu(() => splitMenu(split));
  return (
    <li class={`split-row status-${split.status}`} {...menu}>
      <button type="button" class="split-row-head" aria-expanded={open} onClick={props.onToggle} title={split.error ? `${split.title} – ${split.error}` : split.title}>
        <SplitIcon status={split.status} />
        <span class="split-row-title">{partLabel(split)}</span>
        <span class="split-row-model tabular" title={model || undefined}>
          {parts.name && <span class="split-model-name">{parts.name}{parts.effort ? ' · ' : ''}</span>}
          {parts.effort && <span class="split-model-effort">{parts.effort}</span>}
        </span>
        <span class="split-row-time tabular">{splitDuration(split)}</span>
      </button>
      {open && (
        <div class="split-row-body">
          {split.error && <p class="split-row-error">{split.error}</p>}
          {split.run
            ? <SplitSteps runId={split.run.id} agentId={props.agentId} live={split.status === 'running'} quiet={!!split.error} />
            : <p class="split-row-note">{SPLIT_STATUS_LABEL[split.status]}</p>}
        </div>
      )}
    </li>
  );
}

/** A split's own steps (the parent agent's run stream carries them); none yet: one compact note in the row's body (no
 *  page-sized empty state), nothing under an error that already says why. */
function SplitSteps(props: { runId: string; agentId: string; live: boolean; quiet: boolean }) {
  const { items, error } = useRunItems(props.runId, props.agentId, { enabled: true, live: props.live });
  if (error) return <p class="split-row-error">{error}</p>;
  if (!items) return <span class="split-row-loading"><Spinner size={14} /></span>;
  if (!items.length && !props.live) return props.quiet ? null : <p class="split-row-note">No steps recorded</p>;
  return <RunItemList items={items} live={props.live} window={props.live ? ROW_STEPS : undefined} class="split-steps" />;
}

/** A group's rows in part order; each opens on its own. */
export function SplitList(props: { group: SplitGroupView }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id); else next.add(id);
    setOpen(next);
  };
  useEffect(ensureModelNames, []);
  const splits = props.group.splits.slice().sort((a, b) => a.idx - b.idx);
  return (
    <ul class="split-rows" aria-label={`Splits of ${agentName(props.group.agentId)}`}>
      {splits.map((split) => <SplitRow key={split.id} split={split} agentId={props.group.agentId} open={open.has(split.id)} onToggle={() => toggle(split.id)} />)}
    </ul>
  );
}

/** The words of a tool result (its preview) – a group id named there picks the group; undefined while the call runs. */
function resultText(result: RunItem | undefined): string | undefined {
  if (!result) return undefined;
  return typeof result.data.preview === 'string' ? result.data.preview : '';
}

/**
 * The parent's agents.split step: one 24 px line "Split · 3 of 5 done" (a spinner in the icon slot while parts run),
 * a click opens the split rows below it.
 */
export function SplitStep(props: { call: RunItem; result?: RunItem; live: boolean }) {
  const { call, result } = props;
  const [open, setOpen] = useState(false);
  useEffect(() => watchSplits({ parentRunId: call.runId }), [call.runId, result?.id]);
  const group = groupForCall(groupsOfRun(call.runId), call.createdAt, resultText(result));
  const running = (!result && props.live) || (group ? isLiveGroup(group) : false);
  return (
    <li class={`run-item split-step${running ? ' running' : ''}`}>
      <button type="button" class="run-item-head" aria-expanded={open} onClick={() => setOpen(!open)} title={group?.goal}>
        <span class="run-item-icon" aria-hidden="true">{running ? <Spinner size={12} label="Running" /> : <Icon name="git-branch" size={14} />}</span>
        <span class="run-item-verb">Split</span>
        <span class="run-item-target">{group ? `· ${groupDone(group)}` : ''}</span>
      </button>
      {open && (
        <div class="run-item-body split-step-body">
          {group ? <SplitList group={group} /> : <span class="split-row-loading"><Spinner size={14} /></span>}
        </div>
      )}
    </li>
  );
}

/**
 * The chat's live block of one running group (the live block's frame and byline): the agent, "3 of 5 parts working"
 * in the byline's fixed slot, then its split rows.
 */
export function SplitLiveBlock(props: { group: SplitGroupView }) {
  const { group } = props;
  const name = agentName(group.agentId);
  // While shown: the agent's run stream, so every part's change arrives as it happens.
  useEffect(() => holdRunsTopic(group.agentId), [group.agentId]);
  return (
    <article class="message agent working-message split-live" data-group-id={group.id} aria-label={`${name} split working`}>
      <div class="message-author">
        <AgentAvatar agentId={group.agentId} size={26} working onClick={() => go.agent(group.agentId)} />
        <button type="button" class="author-name" onClick={() => go.agent(group.agentId)}>{name}</button>
        <span class="working-model tabular" title={group.goal}>{groupWorking(group)}</span>
      </div>
      <SplitList group={group} />
    </article>
  );
}

/** An open run's splits in Team › agent › Runs: per group its "Split · 3 of 5 done" line and rows. */
export function RunSplits(props: { runId: string }) {
  useEffect(() => watchSplits({ parentRunId: props.runId }), [props.runId]);
  const groups = groupsOfRun(props.runId);
  if (!groups.length) return null;
  return (
    <div class="run-splits">
      {groups.map((group) => (
        <div key={group.id} class="run-split-group">
          <div class="run-split-head" title={group.goal}>
            <span class="run-item-icon" aria-hidden="true">{isLiveGroup(group) ? <Spinner size={12} label="Running" /> : <Icon name="git-branch" size={14} />}</span>
            <span class="run-item-verb">Split</span>
            <span class="run-item-target">· {groupDone(group)}</span>
          </div>
          <SplitList group={group} />
        </div>
      ))}
    </div>
  );
}
