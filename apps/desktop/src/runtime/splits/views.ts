// Views of split groups (B-057, SplitGroupView / SplitView): a group with its splits in idx order, each split with its
// newest run (SplitRunView) and how many runs it had (a retry is a second run), and the group's summed cost (real money
// and a plan's notional list price) over every run of its splits. Batched: one splits query and one runs query for
// any number of groups.
// Owns: that join. Never: writes, or reads run items (results.ts reads the answers).

import type { RunJournal } from '../contracts.ts';
import '../contracts/splits.ts'; // RunJournal.listBySplit
import type { Run } from '../../shared/model/runs.ts';
import type { Split, SplitGroup, SplitGroupView, SplitRunView, SplitView } from '../../shared/model/splits.ts';
import type { SplitRepo } from '../store/splits.ts';

const RUN_FIELDS = ['id', 'model', 'effort', 'engine', 'status', 'costUsd', 'notionalUsd', 'costBasis', 'summary', 'error', 'startedAt', 'endedAt',
  'inputTokens', 'outputTokens'] as const satisfies ReadonlyArray<keyof SplitRunView>;

/** The run fields a split view carries (absent ones left out). */
export function runView(run: Run): SplitRunView {
  const view: Record<string, unknown> = {};
  for (const key of RUN_FIELDS) if (run[key] !== undefined) view[key] = run[key];
  return view as unknown as SplitRunView;
}

/** The runs of these splits by split id, oldest first (an empty map without the journal's split listing). */
export function runsBySplit(runs: RunJournal, splitIds: readonly string[]): Map<string, Run[]> {
  const out = new Map<string, Run[]>();
  if (!splitIds.length) return out;
  let list: Run[] = [];
  try { list = runs.listBySplit?.(splitIds) ?? []; } catch { list = []; }
  for (const run of list) {
    if (!run.splitId) continue;
    const own = out.get(run.splitId);
    if (own) own.push(run);
    else out.set(run.splitId, [run]);
  }
  return out;
}

const sum = (values: Array<number | undefined>): number | undefined => {
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return known.length ? Math.round(known.reduce((total, value) => total + value, 0) * 1e6) / 1e6 : undefined;
};

function splitView(split: Split, runs: Run[] | undefined): SplitView {
  const latest = runs?.[runs.length - 1];
  return { ...split, ...(latest ? { run: runView(latest) } : {}), runs: runs?.length ?? 0 };
}

/** Full views of these groups, in the order given. */
export function groupViews(deps: { repo: SplitRepo; runs: RunJournal }, groups: readonly SplitGroup[]): SplitGroupView[] {
  if (!groups.length) return [];
  const splits = deps.repo.listSplits({ groupIds: groups.map((group) => group.id) });
  const runs = runsBySplit(deps.runs, splits.map((split) => split.id));
  return groups.map((group) => {
    const own = splits.filter((split) => split.groupId === group.id).sort((a, b) => a.idx - b.idx);
    const all = own.flatMap((split) => runs.get(split.id) ?? []);
    const costUsd = sum(all.map((run) => run.costUsd));
    const notionalUsd = sum(all.map((run) => run.notionalUsd));
    return {
      ...group, splits: own.map((split) => splitView(split, runs.get(split.id))),
      ...(costUsd !== undefined ? { costUsd } : {}), ...(notionalUsd !== undefined ? { notionalUsd } : {}),
    };
  });
}

export function groupView(deps: { repo: SplitRepo; runs: RunJournal }, group: SplitGroup): SplitGroupView {
  return groupViews(deps, [group])[0];
}
