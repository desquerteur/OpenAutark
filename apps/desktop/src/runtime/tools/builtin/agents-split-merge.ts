// agents.split_merge (B-057 S16): the agent that split brings an ended part's own branch (a part with worktree: true)
// into its working folder – merge: --no-ff into the branch the part started from, in the folder it started from – or
// drops it (discard: branch and folder deleted, unsaved work too). Only the agent that split, never a split itself, and
// only once the part has ended (git/split-worktree.ts). A local workspace change (write_local). The split row learns
// the outcome through services.splits.markBranch (optional in the contract).
// Owns: the tool definition and its texts. Never: merges or discards another agent's part, a part that still runs, or
// any branch but the part's own wf/split- branch.

import type { ToolContext, ToolDef } from '../types.ts';
import { failure, text } from '../types.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { SPLIT_LIMITS, SPLIT_TERMINAL, type SplitView } from '../../../shared/model/splits.ts';
import '../../contracts/splits.ts'; // services.splits
import { splitRecordOf, type WorktreeRecord } from '../../git/records.ts';
import { mergeSplit, splitStat } from '../../git/split-worktree.ts';
import { workspaceResource } from './files.ts';
import { clip, defineTool } from './util.ts';

type Args = { groupId: string; idx: number; action: 'merge' | 'discard' };

/** The caller's own part with its branch record; refused in a split's turn and for another agent's group. */
function partOf(ctx: ToolContext, args: Args): { split: SplitView; rec: WorktreeRecord } {
  if (ctx.split) throw new WorkforceError('forbidden', 'A split does not merge or discard parts: my main self does that once the group has ended.');
  const splits = ctx.services.splits;
  if (!splits) throw new WorkforceError('unavailable', 'Splits are not available here.');
  const group = splits.list({ groupId: args.groupId, agentId: ctx.agent.id, limit: 1 }).find((item) => item.id === args.groupId);
  if (!group || group.agentId !== ctx.agent.id) throw new WorkforceError('not_found', `I have no split group ${args.groupId}.`);
  const split = group.splits.find((item) => item.idx === args.idx);
  if (!split) throw new WorkforceError('not_found', `Split group ${args.groupId} has no part #${args.idx}.`);
  const rec = splitRecordOf(ctx.services.db, split.id);
  if (!rec) throw new WorkforceError('not_found', `Part #${split.idx} has no branch of its own: it worked in my folder.`);
  if (!SPLIT_TERMINAL.includes(split.status)) throw new WorkforceError('conflict', `Part #${split.idx} is still ${split.status}. Merge or discard it once it has ended.`);
  if (rec.state === 'merged' || (rec.state === 'discarded' && args.action === 'merge')) throw new WorkforceError('conflict', `Part #${split.idx} is already ${rec.state}.`);
  return { split, rec };
}

const splitMergeTool = defineTool<Args>({
  name: 'agents.split_merge',
  description: 'After my splits ended: merge the branch of a part that had its own worktree (worktree: true) into my working folder, or discard it. I commit my own changes first.',
  inputSchema: {
    type: 'object',
    properties: {
      groupId: { type: 'string', minLength: 1, maxLength: 64, description: 'The split group (from agents.split or the split results).' },
      idx: { type: 'integer', minimum: 1, maximum: SPLIT_LIMITS.partsPerCall, description: 'The part number (#k).' },
      action: { type: 'string', enum: ['merge', 'discard'], description: 'merge: into the branch of my folder; discard: delete the branch and its folder.' },
    },
    required: ['groupId', 'idx', 'action'], additionalProperties: false,
  },
  category: 'write_local',
  describe: (args, ctx) => {
    const { split, rec } = partOf(ctx, args);
    const what = `part #${split.idx} "${clip(split.title, 60)}" (${rec.branch}, ${splitStat(rec)})`;
    if (args.action === 'discard') return { summary: `Discard ${what}: delete its branch and folder`, resource: rec.rel, reversible: false, external: false };
    const workspace = ctx.services.paths.workspace;
    const into = rec.split?.into ?? rec.repo;
    const where = workspaceResource(workspace, into);
    return { summary: `Merge ${what} into ${rec.base} in ${where}`, resource: where, reversible: true, external: false };
  },
  async run(args, ctx) {
    const { split, rec: before } = partOf(ctx, args);
    const result = await mergeSplit(ctx.services, split, args.action, ctx.agent.id);
    const rec = splitRecordOf(ctx.services.db, split.id) ?? before;
    ctx.services.splits?.markBranch?.(split.id, { name: rec.branch, stat: split.branch?.stat ?? splitStat(before), merged: result.outcome });
    if (result.outcome === 'merged') return text(`Merged ${rec.branch} (part #${split.idx}) into ${rec.base}${rec.merge?.sha ? ` (commit ${rec.merge.sha.slice(0, 7)})` : ''}.`);
    if (result.outcome === 'discarded') return text(`Discarded part #${split.idx}: ${rec.branch} and its folder are deleted.`);
    const conflicts = result.conflicts ?? [];
    const list = `${conflicts.slice(0, 10).join(', ')}${conflicts.length > 10 ? ` +${conflicts.length - 10} more` : ''}`;
    return failure(`Can't merge part #${split.idx} automatically: conflicts in ${list}. My folder is unchanged. I merge ${rec.branch} myself there (git merge ${rec.branch}), resolve and commit – or discard the part.`);
  },
});

export const splitMergeTools: ToolDef[] = [splitMergeTool];
