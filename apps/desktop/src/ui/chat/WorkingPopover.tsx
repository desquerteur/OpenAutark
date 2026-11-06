// The chat header's working popover (B-048 E4.5): the live line in the sub line (LiveLine.tsx) opens
// it over the content – anchored to the always reserved sub line, so nothing in the header or the
// chat moves, and it stays open while a run hands over to the next one. One row per member working
// in this chat (live-text.ts workingRows, ordered by start): avatar and name (both open the agent's
// page – where else it works and what it does in parallel), the model it runs on now · effort in a
// fixed slot at the line's end, its live note (a disclosure: the row expands to the run's live steps,
// the newest few like the live block – team/run-items.tsx – and the agent's newest words) and its
// task. B-057: a running split group is one row ("3 of 5 parts working", its goal where a run names its model) that
// opens to its split rows. B-075: the rows and an open row's steps and newest words come from the chat's rows (the
// summary's live runs, each run's row with its meta.live) – the same popover on every device.
// "Stop all agent work" (shell/work-stop.ts) stays its last entry for whoever may stop. On a
// phone the popover is a bottom sheet (mobile.css).
// Owns: the popover's markup and which rows are open. Never: stops one agent, invents a model or
// steps the runtime did not report, or polls.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { ConversationSummary } from '../../shared/model/chat.ts';
import { AgentAvatar, Icon, Popover, Spinner } from '../lib/ui.tsx';
import { agentMap, messagesFor, tasks } from '../lib/store.ts';
import { go } from '../lib/router.ts';
import { can } from '../lib/session.ts';
import { plainPreview } from '../lib/format.ts';
import { openTaskDetail } from '../tasks/jump.ts';
import { RunItemList } from '../team/run-items.tsx';
import { stepItems } from '../team/step-view.ts';
import { stopAllWork, workAction, workStop } from '../shell/work-stop.ts';
import { isLiveWork } from './message-rows.ts';
import { liveWords } from './run-line.ts';
import { liveRuns, workingRows, type WorkingRow } from './live-text.ts';
import { SplitList } from '../splits/SplitRows.tsx'; // B-057
import { liveGroupsOf, splitGroups, watchSplits } from '../splits/split-model.ts';
import { groupStart, groupWorking } from '../splits/split-text.ts';

/** Steps an open row shows before "+N earlier steps" – as many as the live block. */
const ROW_STEPS = 6;
/** The popover's width on the desktop (clamped to the window, lib/popover.tsx). */
const WIDTH = 360;

/** Open state of a chat's working popover; another chat starts closed. `anchor` goes on the sub line. */
export function useWorkingPanel(chatId: string) {
  const anchor = useRef<HTMLDivElement>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = openFor === chatId;
  return {
    anchor, open,
    toggle: () => setOpenFor(open ? null : chatId),
    close: () => {
      // The sub line is no focus target (lib/popover.tsx focuses the anchor on Escape): a close from inside hands focus back to the live line.
      if (document.activeElement?.closest('.working-popover')) anchor.current?.querySelector<HTMLElement>('.chat-live')?.focus({ preventScroll: true });
      setOpenFor(null);
    },
  };
}

type Chat = Pick<ConversationSummary, 'id' | 'working' | 'live'>;

export function WorkingPopover(props: { chat: Chat; anchor: HTMLElement | null; open: boolean; onClose: () => void }) {
  const { chat, open, onClose } = props;
  const body = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => body.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);
  if (!open) return null;
  const list = messagesFor(chat.id).value;
  const metaOf = (runId: string) => list.find((message) => message.runId === runId && isLiveWork(message))?.meta;
  const groups = liveGroupsOf(chat.id).map((group) => ({ id: group.id, agentId: group.agentId, startedAt: groupStart(group), note: groupWorking(group), goal: group.goal })); // B-057: one row per running split group (its goal in the model slot)
  const rows = workingRows(chat, liveRuns(chat), (id) => agentMap.value.get(id)?.name, metaOf, groups);
  const toggle = (key: string) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key); else next.add(key);
    setExpanded(next);
  };
  const stop = workAction(workStop.value) === 'stop';
  return (
    <Popover anchor={props.anchor} open={open} onClose={onClose} placement="bottom-start" width={WIDTH} class="working-popover" label="Agent work">
      <div ref={body}>
        <div class="menu-section">
          <div class="menu-title">Working now</div>
          {rows.length
            ? <ul class="working-rows">{rows.map((row) => <Row key={row.key} row={row} chatId={chat.id} open={expanded.has(row.key)} onToggle={() => toggle(row.key)} onLeave={onClose} />)}</ul>
            : <p class="working-empty">Nobody is working right now</p>}
        </div>
        {stop && (
          <div class="menu-section">
            <button type="button" class="menu-item danger" onClick={() => { onClose(); void stopAllWork(); }}>
              <Icon name="stop-circle" size={18} />
              <span class="menu-label">
                <span>Stop all agent work</span>
                <small>Every agent on this PC stops now; their tasks pause.</small>
              </span>
            </button>
          </div>
        )}
      </div>
    </Popover>
  );
}

function Row(props: { row: WorkingRow; chatId: string; open: boolean; onToggle: () => void; onLeave: () => void }) {
  const { row, open } = props;
  const toAgent = () => { props.onLeave(); go.agent(row.agentId); };
  const task = row.taskId ? tasks.value.find((item) => item.id === row.taskId) : undefined;
  const note = <span class="working-row-note">{row.note}</span>;
  return (
    <li class="working-row" data-agent-id={row.agentId} data-run-id={row.runId}>
      <span class="working-row-avatar"><AgentAvatar agentId={row.agentId} size={24} working onClick={toAgent} /></span>
      <div class="working-row-main">
        <div class="working-row-head">
          <button type="button" class="working-row-name" onClick={toAgent}>{row.name}</button>
          <span class="working-row-model tabular" title={row.model || undefined}>{row.model}</span>
        </div>
        {row.runId || row.groupId
          ? <button type="button" class="working-row-toggle" aria-expanded={open} onClick={props.onToggle}>
            <Icon name={open ? 'caret-down' : 'caret-right'} size={12} />{note}
          </button>
          : <span class="working-row-toggle"><span class="working-row-caret" />{note}</span>}
        {row.taskId && can('tasks.get') && (
          <button type="button" class="working-task text-button" onClick={() => { props.onLeave(); openTaskDetail(row.taskId!); }}>
            <Icon name="list-checks" size={14} /><span>{task?.title ?? 'Task'}</span>
          </button>
        )}
        {open && row.runId && <RowDetail runId={row.runId} agentId={row.agentId} chatId={props.chatId} />}
        {open && row.groupId && <GroupDetail groupId={row.groupId} />}
      </div>
    </li>
  );
}

/** An open row: the run's live steps (newest few, from its row's meta.live) and the agent's newest words (its body). */
function RowDetail(props: { runId: string; agentId: string; chatId: string }) {
  const message = messagesFor(props.chatId).value.find((item) => item.runId === props.runId && isLiveWork(item));
  const live = message?.meta.live;
  const items = stepItems(props.runId, live?.steps ?? []);
  const words = liveWords({ body: message?.body });
  return (
    <div class="working-row-detail">
      <RunItemList items={items} live window={ROW_STEPS} earlier={live?.more} class="live-steps" />
      {!items.length && !words && <p class="working-row-empty">No steps yet</p>}
      {words && <p class="working-row-words" aria-live="polite">{plainPreview(words, 240)}</p>}
    </div>
  );
}

/** B-057: an open split group row – its split rows (each opens to its own steps); a group only the activity named is read. */
function GroupDetail(props: { groupId: string }) {
  const readable = can('splits.list');
  const group = splitGroups.value.get(props.groupId);
  const known = Boolean(group);
  useEffect(() => (readable && !known ? watchSplits({ groupId: props.groupId }) : undefined), [props.groupId, readable, known]);
  return (
    <div class="working-row-detail">
      {group ? <SplitList group={group} />
        : readable ? <span class="working-row-loading"><Spinner size={14} /></span> : <p class="working-row-empty">Splits are not available here</p>}
    </div>
  );
}
