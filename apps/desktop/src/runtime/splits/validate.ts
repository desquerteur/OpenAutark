// The checks of a new split group (B-057 S8/S10/S11/S16), all before anything is written: the caller is no split
// itself (depth 1), the agent exists and is active (not archived, not paused by the person – S13), a goal, 1–12 parts with a title, a brief and an optional 'returns'
// within SPLIT_LIMITS, context fork|brief, model same|cheap|strong|a known and usable catalog model, an effort of the
// Effort scale, `after` naming only lower parts, a worktree part only with a working folder, at most
// SPLIT_LIMITS.activeGroupsPerAgent groups of the agent pending or running.
// Whether the working folder can give a part its own worktree needs git (asynchronous): the runner checks it when the
// part starts and fails that part with git's reason (runner.ts) – create stays synchronous.
// Owns: those checks and their texts. Never: writes, starts or routes anything.

import { WorkforceError, type ErrorCode } from '../../shared/errors.ts';
import type { Effort, ModelInfo } from '../../shared/model/providers.ts';
import { SPLIT_LIMITS, type SplitContext, type SplitPartInput } from '../../shared/model/splits.ts';
import type { SplitCreateContext } from '../contracts/splits.ts';
import { EFFORT_ORDER } from '../models/efforts.ts';
import { BUSY_GROUPS, type SplitCore } from './core.ts';

export const NESTED_TEXT = 'A split cannot split again; I do my part and put the result in my final text.';
export const MODEL_WORDS = ['same', 'cheap', 'strong'] as const;

/** A part as stored: trimmed, defaults applied ('same' model = none named). */
export interface CheckedPart {
  title: string; brief: string; returns?: string; context: SplitContext; model?: string; effort?: Effort; after: number[]; worktree: boolean;
}

function no(message: string, code: ErrorCode = 'bad_request'): never {
  throw new WorkforceError(code, message);
}

function textOf(value: unknown, what: string, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null) return required ? no(`${what} is missing.`) : undefined;
  if (typeof value !== 'string') return no(`${what} must be text.`);
  const text = value.trim();
  if (!text) return required ? no(`${what} is empty.`) : undefined;
  if (text.length > max) no(`${what} is ${text.length} characters long; at most ${max}.`);
  return text;
}

/** 'cheap' | 'strong' | a catalog id; undefined for 'same' or nothing. */
function modelOf(core: SplitCore, given: unknown, part: string): string | undefined {
  if (given === undefined || given === null || given === '') return undefined;
  if (typeof given !== 'string') return no(`${part}: model must be same, cheap, strong or a model id from models.list.`);
  const name = given.trim();
  const word = name.toLowerCase();
  if (word === 'same') return undefined;
  if (word === 'cheap' || word === 'strong') return word;
  let info: ModelInfo | undefined;
  try {
    const catalog = core.services()?.catalog;
    info = catalog?.get(name) ?? catalog?.list().find((model) => model.model === name || model.name === name);
  } catch { info = undefined; }
  if (!info) return no(`${part}: unknown model "${name.slice(0, 80)}" – use same, cheap, strong or a model id from models.list.`, 'not_found');
  if (!info.available) return no(`${part}: ${info.name} has no usable account right now – use same, cheap or strong.`, 'conflict');
  return info.id;
}

function effortOf(given: unknown, part: string): Effort | undefined {
  if (given === undefined || given === null || given === '') return undefined;
  if (typeof given === 'string' && (EFFORT_ORDER as readonly string[]).includes(given)) return given as Effort;
  return no(`${part}: effort must be one of ${EFFORT_ORDER.join(', ')}.`);
}

function afterOf(given: unknown, idx: number, part: string): number[] {
  if (given === undefined || given === null) return [];
  if (!Array.isArray(given)) return no(`${part}: after must be a list of part numbers.`);
  const out: number[] = [];
  for (const value of given) {
    if (!Number.isInteger(value) || value < 1 || value >= idx) {
      no(idx === 1 ? `${part}: the first part waits for no other – leave its after out.` : `${part}: after names earlier parts only (#1–#${idx - 1}).`);
    }
    if (!out.includes(value)) out.push(value);
  }
  return out.sort((a, b) => a - b);
}

function partOf(core: SplitCore, ctx: SplitCreateContext, given: SplitPartInput, idx: number): CheckedPart {
  const part = `Part #${idx}`;
  if (!given || typeof given !== 'object' || Array.isArray(given)) return no(`${part} must be an object with a title and a brief.`);
  const title = textOf(given.title, `${part}'s title`, SPLIT_LIMITS.titleChars, true)!;
  const brief = textOf(given.brief, `${part}'s brief`, SPLIT_LIMITS.briefChars, true)!;
  const returns = textOf(given.returns, `${part}'s returns`, SPLIT_LIMITS.returnsChars, false);
  const context = given.context === undefined || given.context === null ? 'fork' : given.context;
  if (context !== 'fork' && context !== 'brief') no(`${part}: context must be fork or brief.`);
  if (given.worktree !== undefined && given.worktree !== null && typeof given.worktree !== 'boolean') no(`${part}: worktree must be true or false.`);
  const worktree = given.worktree === true;
  if (worktree && !ctx.cwd) no(`${part} asks for its own worktree, but this turn has no working folder (a git repository in the workspace).`, 'conflict');
  const model = modelOf(core, given.model, part);
  const effort = effortOf(given.effort, part);
  return {
    title, brief, ...(returns ? { returns } : {}), context, ...(model ? { model } : {}), ...(effort ? { effort } : {}),
    after: afterOf(given.after, idx, part), worktree,
  };
}

/** Every check of a new group (see the header); the goal and the parts as they are stored. Throws WorkforceError. */
export function checkCreate(core: SplitCore, ctx: SplitCreateContext, input: { goal: unknown; parts: unknown }): { goal: string; parts: CheckedPart[] } {
  if (ctx.split) no(NESTED_TEXT, 'forbidden');
  const agent = core.deps.org.get(ctx.agentId);
  if (!agent) no(`No agent ${ctx.agentId}.`, 'not_found');
  if (agent!.archivedAt !== undefined) no(`${agent!.name} is archived.`, 'conflict');
  // S13: paused by the person (or a manager) while this turn ran – its splits would be stopped at once.
  if (agent!.status === 'paused') no(`${agent!.name} was paused, so it does not split now.`, 'conflict');
  const goal =textOf(input?.goal, 'The goal', SPLIT_LIMITS.goalChars, true)!;
  const given = input?.parts;
  if (!Array.isArray(given) || given.length < 1 || given.length > SPLIT_LIMITS.partsPerCall) {
    no(`Give 1–${SPLIT_LIMITS.partsPerCall} parts (got ${Array.isArray(given) ? given.length : 'none'}).`);
  }
  const parts = (given as SplitPartInput[]).map((part, index) => partOf(core, ctx, part, index + 1));
  const busy = core.repo.listGroups({ agentId: ctx.agentId, statuses: BUSY_GROUPS }).length;
  if (busy >= SPLIT_LIMITS.activeGroupsPerAgent) {
    no(`${busy} split groups of mine are still running (at most ${SPLIT_LIMITS.activeGroupsPerAgent}). I wait for their results, or stop one with agents.split_stop.`, 'conflict');
  }
  return { goal, parts };
}
