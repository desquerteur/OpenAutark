// Live work (D5, like Codex): the real agent, the task it works on, its steps as compact lines right
// away – the newest LIVE_STEPS, "+N earlier steps" above them, the newest at the bottom with a
// spinner while it runs, reasoning as "Thought · <headline>" shimmering while written – and one live
// line below (run-line.ts: the agent's newest words while it writes, else its live note). The
// slots are fixed: the byline (B-048 E4.5: with the model it runs on · effort in a reserved slot after
// the name – live-text.ts modelLine, updated after a failover), the task line, the steps, the live
// line (one line, ellipsis).
// B-075: everything here comes from the run's row – its body and meta.live (note, steps, how many came before, model ·
// effort, task) – so every window, linked PC and phone draws the same block from the same synced value. Where this
// connection may read the run's journal (the home PC), a click on "+N earlier steps" or on a stopped run's steps
// shows the journaled steps instead (every step, with its input and output), live while the run runs.
// PendingWork renders every live run of the chat after all rows, ordered by start (message-rows.ts
// liveWork): what the run posts meanwhile (approvals, status lines, cards) sits above it, the
// newest activity is always at the bottom. When the run ends its answer takes this place (moved to
// the end of the chat, D4) with the steps folded into "Worked … · N steps" above the body (from the row's meta).
// A turn the person stopped before it wrote anything keeps this block in its place (`stopped`: no
// ring, "Stopped · <last step>", its steps – meta.lines – one click away), so stopping moves no message above it.
// B-057: a running split group of the chat is one block among them, in the same frame (SplitLiveBlock).
// Owns: this block. Never: invents progress, shows the streamed body twice, or polls.

import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import { LIVE_STEPS, type Message } from '../../shared/model/chat.ts';
import { agentName, tasks } from '../lib/store.ts';
import { AgentAvatar, Icon } from '../lib/ui.tsx';
import { go } from '../lib/router.ts';
import { can } from '../lib/session.ts';
import { plainPreview } from '../lib/format.ts';
import { openTaskDetail } from '../tasks/jump.ts';
import { RunItemList, useRunItems } from '../team/run-items.tsx';
import { stepItems } from '../team/step-view.ts';
import { liveStart, liveWork } from './message-rows.ts';
import { earlierSteps, workingLine } from './run-line.ts';
import { modelLine } from './live-text.ts';
import { SplitLiveBlock } from '../splits/SplitRows.tsx'; // B-057: one live block per running split group
import { liveGroupsOf } from '../splits/split-model.ts';
import { groupStart } from '../splits/split-text.ts';

// A stopped run's steps open on click: that state belongs to the run and survives a remount (and
// reopening its chat). Keep at most 64 recent open ones.
const expandedRuns = signal<ReadonlySet<string>>(new Set());
/** The task each run shown here worked on (its row says so while it runs): a stopped run keeps its task line. */
const runTasks = new Map<string, string>();

/** One run's live block from its row (`stopped`: the person stopped it before it wrote anything). */
export function WorkingMessage(props: { message: Message; stopped?: boolean }) {
  const { message, stopped } = props;
  const runId = message.runId ?? message.id;
  const agentId = message.authorId;
  const live = message.meta.live;
  if (live?.taskId) { runTasks.delete(runId); runTasks.set(runId, live.taskId); if (runTasks.size > 200) runTasks.delete(runTasks.keys().next().value!); }
  const taskId = live?.taskId ?? runTasks.get(runId);
  const open = expandedRuns.value.has(runId);
  const toggle = () => {
    const next = new Set(expandedRuns.peek());
    if (next.has(runId)) next.delete(runId); else next.add(runId);
    if (next.size > 64) next.delete(next.values().next().value!);
    expandedRuns.value = next;
  };
  // "+N earlier steps" asked for every step: this PC's journal of the run, where this connection may read it.
  const [earlierOpen, setEarlierOpen] = useState(false);
  const readable = can('runs.items');
  const journal = useRunItems(runId, agentId, { enabled: readable && (stopped ? open : earlierOpen), live: !stopped });
  const rich = journal.items?.length ? journal.items : null;
  const steps = stopped ? (message.meta.lines ?? []) : (live?.steps ?? []);
  const items = rich ?? stepItems(runId, steps);
  const text = workingLine({ stopped, steps, body: message.body, note: live?.note });
  const task = tasks.value.find(task => task.id === taskId);
  const model = modelLine(live ? { modelName: live.model, effort: live.effort } : undefined, message.meta);
  return (
    <article class={`message agent working-message${stopped ? ' stopped' : ''}`} data-message-id={message.id} aria-label={`${agentName(agentId)} ${stopped ? 'stopped' : 'working'}`}>
      <div class="message-author">
        <AgentAvatar agentId={agentId} size={26} working={!stopped} onClick={() => go.agent(agentId)} />
        <button type="button" class="author-name" onClick={() => go.agent(agentId)}>{agentName(agentId)}</button>
        {/* B-048 E4.5: the model it runs on · effort, in a slot that is there from the first frame (empty while routing) */}
        <span class="working-model tabular" title={model || undefined}>{model}</span>
      </div>
      {taskId && can('tasks.get') && <button type="button" class="working-task text-button" onClick={() => openTaskDetail(taskId)}>
        <Icon name="list-checks" size={14} /><span>{task?.title ?? 'Task'}</span>
      </button>}
      {stopped ? <>
        <button type="button" class="working-update" aria-expanded={open} onClick={toggle}>
          <Icon name={open ? 'caret-down' : 'caret-right'} size={12} />
          <span>{plainPreview(text, 240)}</span>
        </button>
        {open && <div class="working-history"><RunItemList items={items} earlier={rich ? 0 : earlierSteps(message.meta)} /></div>}
      </> : <>
        <RunItemList items={items} live window={LIVE_STEPS} earlier={rich ? 0 : live?.more} class="live-steps"
          onEarlier={readable && !journal.error ? () => setEarlierOpen(true) : undefined} />
        <div class="working-update live">
          <span class="working-text" aria-live="polite">{plainPreview(text, 240)}</span>
        </div>
      </>}
    </article>
  );
}

/** Every live run of this chat after all rows, ordered by start: its rows that still stream (message-rows.ts liveWork).
 *  B-057: a running split group is ONE block (splits/SplitRows.tsx SplitLiveBlock), never one per split. */
export function PendingWork(props: { conversationId: string; messages: readonly Message[] }) {
  const runs = liveWork(props.messages).map((message) => ({ at: liveStart(message), node: <WorkingMessage key={message.runId} message={message} /> }));
  const groups = liveGroupsOf(props.conversationId).map((group) => ({ at: groupStart(group), node: <SplitLiveBlock key={`split:${group.id}`} group={group} /> }));
  return <>{(groups.length ? [...runs, ...groups].sort((a, b) => a.at - b.at) : runs).map((item) => item.node)}</>;
}
