// Agent page: current and recent runs (agents.runs), each expandable to its run items (team/run-items.tsx – the
// same list the chat's "Worked … · N steps" line opens). Live while open: the view holds `runs:<agentId>`
// (counted, team/run-items.tsx) and applies run events. A running row has Stop. A run's trigger reads as its
// origin's label ("New mail in office@…", "Routine "Morning check"") when it has one, else the wake reason's.
// B-057: a split's run is no row of its own – an open parent run lists its splits below its steps
// (splits/SplitRows.tsx RunSplits), each opening to its steps; its agents.split call stays an ordinary step
// line here (SplitStepRows false), so a run's splits show once.
// Owns: the runs list, its run events and the trigger words. Never: polls, or renders run items itself.

import { useEffect, useState } from 'preact/hooks';
import type { Run, WakeReason } from '../../shared/model/runs.ts';
import { Button, EmptyState, Spinner } from '../lib/ui.tsx';
import { rpc, errorText } from '../lib/rpc.ts';
import { conversationMap } from '../lib/store.ts';
import { chatTitle } from '../lib/chat-naming.ts';
import { fullDate, listTime, plainPreview } from '../lib/format.ts';
import { toastError } from '../lib/toasts.ts';
import { RunItems, holdRunsTopic } from './run-items.tsx';
import { RunSplits, SplitStepRows } from '../splits/SplitRows.tsx'; // B-057
import { elapsedText } from '../splits/split-text.ts';

const TRIGGERS: Record<WakeReason, string> = {
  message: 'Message', task: 'Task', schedule: 'Schedule', answer: 'Answer', approval: 'Approval', handoff: 'Handoff',
  child: 'Delegated work finished', retry: 'Retry', review: 'Review', report: 'Report to manager', manual: 'Manual', setup: 'Setup',
  event: 'Event', split: 'Split', // B-057
};

/** What started a run: its origin's label, else the wake reason's (B-054). */
function triggerLabel(run: Pick<Run, 'trigger' | 'origin'>): string {
  return run.origin?.label || TRIGGERS[run.trigger] || run.trigger;
}
const STATUS: Record<Run['status'], string> = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed', interrupted: 'Stopped', unknown: 'Unknown' };
const RUN_LIMIT = 20;

/** How long a run took (or runs so far): "4 s", "2 min 5 s", "1 h 3 min"; '' before it started (split rows say the same). */
function runDuration(run: Pick<Run, 'startedAt' | 'endedAt'>): string {
  return elapsedText(run.startedAt, run.endedAt);
}

function RunRow(props: { run: Run }) {
  const { run } = props;
  const [open, setOpen] = useState(run.status === 'running');
  const [stopping, setStopping] = useState(false);
  const chat = run.conversationId ? conversationMap.value.get(run.conversationId) : undefined;
  const live = run.status === 'running' || run.status === 'queued';
  const stop = async () => {
    setStopping(true);
    try { await rpc.call('runs.cancel', { runId: run.id }); } catch (err) { toastError(err, 'Could not stop the run'); } finally { setStopping(false); }
  };
  const meta = [triggerLabel(run), chat && chatTitle(chat), run.model, runDuration(run), run.costUsd ? `$${run.costUsd.toFixed(run.costUsd < 1 ? 3 : 2)}` : ''].filter(Boolean).join(' · ');
  return (
    <li class={`run-row status-${run.status}`}>
      <div class="run-head">
        <button type="button" class="run-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span class="run-state" title={STATUS[run.status]}>{live ? <Spinner size={14} label={STATUS[run.status]} /> : <span class={`run-dot ${run.status}`} aria-label={STATUS[run.status]} />}</span>
          <span class="run-text">
            <span class="run-title">{run.summary ? plainPreview(run.summary, 140) : STATUS[run.status]}</span>
            <span class="run-meta">{meta}</span>
          </span>
          {run.startedAt && <time class="run-time tabular" title={fullDate(run.startedAt)}>{listTime(run.startedAt)}</time>}
        </button>
        {live && <Button variant="ghost" busy={stopping} onClick={() => void stop()}>Stop</Button>}
      </div>
      {run.error && <p class="run-error">{run.error}</p>}
      {run.route && open && <p class="run-route muted">{run.route.reason}</p>}
      {open && <SplitStepRows.Provider value={false}><RunItems run={run} /></SplitStepRows.Provider>}
      {open && <RunSplits runId={run.id} />}
    </li>
  );
}

export function AgentRuns(props: { agentId: string }) {
  const { agentId } = props;
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => rpc.call('agents.runs', { id: agentId, limit: RUN_LIMIT })
      .then((list) => { if (alive) { setRuns(list.filter((run) => !run.splitId)); setError(null); } }) // B-057: split runs sit under their parent run
      .catch((err) => { if (alive) setError(errorText(err)); });
    const release = holdRunsTopic(agentId); // before the read: no run event falls between the two
    void load();
    const offRun = rpc.on('run.upserted', (run) => {
      if (run.agentId !== agentId || run.splitId) return;
      setRuns((current) => {
        const list = current ?? [];
        const next = list.some((entry) => entry.id === run.id) ? list.map((entry) => (entry.id === run.id ? run : entry)) : [run, ...list];
        return next.slice(0, RUN_LIMIT);
      });
    });
    const offOpen = rpc.onOpen(() => { void load(); });
    return () => { alive = false; offRun(); offOpen(); release(); };
  }, [agentId]);

  if (error) return <p class="run-error">{error}</p>;
  if (!runs) return <div class="run-loading"><Spinner size={16} /></div>;
  if (!runs.length) return <EmptyState>No runs yet.</EmptyState>;
  const sorted = runs.slice().sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return <ul class="run-list">{sorted.map((run) => <RunRow key={run.id} run={run} />)}</ul>;
}
