// Split tools (B-057 "Ultra mode"): an agent splits ITSELF into parallel parts (shared/model/splits.ts) and decides
// itself whether, when and how – agents.split (every mode; since 30.10.2026 reached through tools.find / tools.call, not
// in the direct core – the environment's 'Splitting' line names it; a learned tool joins the direct offer), agents.split_results
// (the full results when the parent's results block cut a part short) and agents.split_stop (its own splits only).
// agents.split stores the group through services.splits (runtime/splits/service.ts – validation, limits, budget) with the
// calling turn's facts – its run, chat, task, origin, thread (threadKey of the call = the turn plan's thread), mode and
// working folder (git/records.ts turnCwd = the turn's cwd) – and returns at once: the parts start when this turn ends
// (S3), their results come back in one block on the parent's next turn on that thread (S6).
// A split never splits again or stops splits (S8: run() refuses – a structural recursion guard); agents.split_results
// stays open to it (its parent's thread).
// Owns: the three tools' wording, schemas and results. Never: creates, starts or stops a split itself (the split service
// does), or passes agent-written text anywhere but the split service.

import type { ToolContext, ToolDef } from '../types.ts';
import { failure, json, text } from '../types.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { threadKey } from '../../../shared/model/origin.ts';
import { SPLIT_LIMITS, type SplitGroupView, type SplitPartInput } from '../../../shared/model/splits.ts';
import type { SplitCreateContext } from '../../contracts/splits.ts';
import { EFFORT_ORDER } from '../../models/efforts.ts';
import { turnCwd } from '../../git/records.ts';
import { clip, defineTool, internal } from './util.ts';

export const SPLIT_TOOL = 'agents.split';
/** S8: what a split hears when it calls agents.split or agents.split_stop. */
const splitOnly = (toolName: string): string => `As a split I work on my part and report through my final text; ${toolName} is my main self's.`;
const UNAVAILABLE = 'Splitting is not available here. I do the parts myself, one after another.';

/** The tool result's note to the parent (S3). */
export function nextText(parts: number): string {
  const splits = parts === 1 ? 'My split starts' : `My ${parts} splits start`;
  return `${splits} as soon as this turn ends. I end my turn now (a short line to the person fits). Their results come back to me in one block.`;
}

const PART_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: SPLIT_LIMITS.titleChars },
    brief: { type: 'string', minLength: 1, maxLength: SPLIT_LIMITS.briefChars },
    returns: { type: 'string', minLength: 1, maxLength: SPLIT_LIMITS.returnsChars },
    context: { type: 'string', enum: ['fork', 'brief'] },
    model: { type: 'string', minLength: 1, maxLength: 200 },
    effort: { type: 'string', enum: [...EFFORT_ORDER] },
    after: { type: 'array', items: { type: 'integer', minimum: 1, maximum: SPLIT_LIMITS.partsPerCall - 1 }, maxItems: SPLIT_LIMITS.partsPerCall - 1 },
    worktree: { type: 'boolean' },
  },
  required: ['title', 'brief'], additionalProperties: false,
};

// Shown when the agent looks it up (tools.find) or has learned it: kept ≤ 900 characters, no schema property descriptions (B-057 I4).
const DESCRIPTION = 'Split myself into parallel parts: each starts as me, does only its part; results come back to me in one block to merge. '
  + 'For many independent pieces (code changes on separate files, broad searches, many analyses, collating data) and independent checks; not for one small step. '
  + 'Parts start when this turn ends; I end my turn then. '
  + 'Per part: brief = its exact job; returns = what to hand back; context fork (default: knows this conversation) or brief (fresh, cheaper, independent); '
  + 'model same|cheap|strong|<id> (default same), effort; after = parts it runs after, getting their results (pipelines, checks like "refute #2"); '
  + 'worktree: true = own git branch from my last commit (commit first; the app commits its work; merge with agents.split_merge). '
  + 'Give code parts separate files; browser work goes to one part only. Parts never split, talk to people or remember.';

/** The thread a split call belongs to: the turn's (the plan's threadKey); a split's own call – its parent's. */
function ownThread(ctx: ToolContext): string {
  return ctx.split?.parentThread ?? threadKey({ conversationId: ctx.conversationId, taskId: ctx.taskId, origin: ctx.origin });
}

/** The turn's working folder (agents/turn-attempt.ts: turnCwd of its task and agent). */
function cwdOf(ctx: ToolContext): string | undefined {
  try {
    const task = ctx.taskId ? ctx.services.tasks.get(ctx.taskId) : undefined;
    return turnCwd(ctx.services, task, ctx.agent.id);
  } catch {
    return undefined;
  }
}

/** The calling turn's facts (runtime-set, never the agent's text). */
export function createContext(ctx: ToolContext): SplitCreateContext {
  const cwd = cwdOf(ctx);
  return {
    agentId: ctx.agent.id, runId: ctx.runId, thread: ownThread(ctx), modeKey: ctx.mode,
    ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}), ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
    ...(ctx.origin ? { origin: ctx.origin } : {}), ...(cwd ? { cwd } : {}), ...(ctx.split ? { split: ctx.split } : {}),
  };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

const split = defineTool<{ goal: string; parts: SplitPartInput[] }>({
  name: SPLIT_TOOL,
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string', minLength: 1, maxLength: SPLIT_LIMITS.goalChars },
      parts: { type: 'array', items: PART_SCHEMA, minItems: 1, maxItems: SPLIT_LIMITS.partsPerCall },
    },
    required: ['goal', 'parts'], additionalProperties: false,
  },
  category: 'think',
  describe: (args) => {
    const parts = Array.isArray(args.parts) ? args.parts : [];
    return internal(clip(`Split into ${plural(parts.length, 'part')}: ${parts.map((part) => part.title).join(', ')}`, 200));
  },
  async run(args, ctx) {
    if (ctx.split) return failure(splitOnly(SPLIT_TOOL));
    const splits = ctx.services.splits;
    if (!splits) return failure(UNAVAILABLE);
    let group: SplitGroupView;
    try {
      group = splits.create(createContext(ctx), { goal: args.goal, parts: args.parts });
    } catch (error) {
      if (error instanceof WorkforceError) return failure(`${error.message} Nothing was split.`);
      throw error;
    }
    const parts = group.splits.map((part) => ({ idx: part.idx, title: part.title, id: part.id }));
    return json({ ok: true, groupId: group.id, parts, next: nextText(parts.length) });
  },
});

const results = defineTool<{ groupId?: string; idx?: number }>({
  name: 'agents.split_results',
  description: 'The full results of my splits: one part (groupId and idx), a group (groupId) or my newest group in this thread. Use it when the results block cut a part short.',
  inputSchema: {
    type: 'object',
    properties: { groupId: { type: 'string', minLength: 1, maxLength: 80 }, idx: { type: 'integer', minimum: 1, maximum: SPLIT_LIMITS.partsPerCall } },
    additionalProperties: false,
  },
  category: 'read',
  describe: (args) => internal(`Read split results${args.groupId ? ` of ${args.groupId}` : ''}${args.idx ? ` #${args.idx}` : ''}`),
  async run(args, ctx) {
    const splits = ctx.services.splits;
    if (!splits) return failure(UNAVAILABLE);
    return text(splits.results(ctx.agent.id, { ...(args.groupId ? { groupId: args.groupId } : {}), ...(args.idx ? { idx: args.idx } : {}), thread: ownThread(ctx) }));
  },
});

const stop = defineTool<{ groupId?: string; idx?: number }>({
  name: 'agents.split_stop',
  description: 'Stop my splits: one part (groupId and idx), a group (groupId), or every running or waiting split I started in this thread. Stopped parts report as stopped.',
  inputSchema: {
    type: 'object',
    properties: { groupId: { type: 'string', minLength: 1, maxLength: 80 }, idx: { type: 'integer', minimum: 1, maximum: SPLIT_LIMITS.partsPerCall } },
    additionalProperties: false,
  },
  category: 'think',
  describe: (args) => internal(`Stop splits${args.groupId ? ` of ${args.groupId}` : ''}${args.idx ? ` #${args.idx}` : ''}`),
  async run(args, ctx) {
    if (ctx.split) return failure(splitOnly('agents.split_stop'));
    const splits = ctx.services.splits;
    if (!splits) return failure(UNAVAILABLE);
    const by = ctx.agent.id;
    if (args.idx !== undefined && !args.groupId) return failure(`Name the group of part #${args.idx} (groupId).`);
    if (!args.groupId) {
      const thread = ownThread(ctx);
      const groups = splits.list({ agentId: by, active: true }).filter((group) => group.agentId === by && group.thread === thread);
      return json({ ok: true, stopped: groups.reduce((sum, group) => sum + splits.stop({ groupId: group.id }, by), 0) });
    }
    // Only the agent's own groups (checked here: the service stops whatever it is named).
    const group = splits.list({ groupId: args.groupId, limit: 1 }).find((item) => item.id === args.groupId);
    if (!group || group.agentId !== by) return failure(`I have no split group ${clip(args.groupId, 80)}.`);
    if (args.idx === undefined) return json({ ok: true, stopped: splits.stop({ groupId: group.id }, by) });
    const part = group.splits.find((item) => item.idx === args.idx);
    if (!part) return failure(`Group ${group.id} has no part #${args.idx}.`);
    return json({ ok: true, stopped: splits.stop({ splitId: part.id }, by) });
  },
});

export const splitTools: ToolDef[] = [split, results, stop];
