// The decide tool (RT9): an agent hands a bounded choice – 2 to 255 options – to the decision
// model (decision/service.ts), optionally over the output of a read tool it names as `source`, and
// gets back 'choice', 'none_fit' (no option fits) or 'unsure' (then it decides itself). A core
// tool (tools/registry.ts CORE_TOOLS), offered in every mode; the journal never shows its context.
// Numeric options (e.g. seconds to wait) travel as labels and return as numbers.
// Owns: the decide definition, the options rule (distinct also ignoring case, as the hub matches a
// pick), the source rules – judged before anything runs, also without a decision model: an
// existing tool of category 'read' offered in the mode and valid arguments; then run through registry.call, so the
// mode's offer applies as for a direct call –, the decision context (the agent's
// context, then the source's output; the hub caps it at 12k), the stop (a stopped turn ends the
// decision: DecisionRequest.signal), the reply and the run note { decision: { question, outcome,
// by, … } } (`source` only when it ran).
// Never: returns the source's output (or a part of it) to the agent, runs a source that does more
// than read, journals the context, or decides anything itself when no decision model answers.

import { randomUUID } from 'node:crypto';
import type { DecisionResult } from '../../contracts.ts';
import type { ModeInfo } from '../../../shared/model/knowledge.ts';
import { toErrorData } from '../../../shared/errors.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';
import { failure, json } from '../types.ts';
import { outputText, preview } from '../outputs.ts';
import { validate } from '../validate.ts';
import { outcomeOf } from '../../decision/service.ts';
import { MAX_OPTIONS, NONE_OPTION } from '../../decision/types.ts';
import { MCP_SERVER_NAME } from '../../mcp/names.ts';
import { clip, defineTool, internal } from './util.ts';

export const DECIDE_TOOL = 'decide';
/** The agent's own context; the rest of the hub's 12k characters is left for the source's output. */
export const MAX_DECIDE_CONTEXT = 4000;
/** One decision's deadline over every backend (the LLM fallback is a whole engine turn). */
export const DECIDE_TIMEOUT_MS = 45_000;
export const UNSURE_HINT = 'I decide myself.';
export const UNSURE_SOURCE_HINT = 'I decide myself or read the source.';
export const STOPPED = 'Stopped before the decision.';
/** specsFor without an engine filter: a source is judged by the mode's offer only, like registry.call does. */
const ANY_ENGINE = { ownTools: false, via: 'mcp' } as const;

interface Source { tool: string; args?: Record<string, unknown> }
interface DecideArgs { question: string; options: Array<string | number>; context?: string; source?: Source }
type Checked = { name: string; args: Record<string, unknown> };

const decide = defineTool<DecideArgs>({
  name: DECIDE_TOOL,
  description: 'Hand a bounded choice to the decision model: a question and 2–255 text or number options (e.g. which file, which category, seconds to wait). A selected number is returned as a number. '
    + 'It answers outcome "choice" (with choice and confidence), "none_fit" (none of the options fits) or "unsure" (low confidence or no decision model: I decide myself). '
    + 'context: the facts it needs. source: a read tool to run first ({tool, args}, e.g. files.list); its output goes only to the decision model, never to me – '
    + 'I use it when I need the pick, not the content. It judges; it does not count, compute or extract exact text from long data (it sees a bounded excerpt) – for that I use files.search, a command or my own reading. '
    + 'A source call that would spend or change anything is refused. "none" stays off the list: it is always possible.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', minLength: 1, maxLength: 1000 },
      options: { type: 'array', minItems: 2, maxItems: MAX_OPTIONS, items: { anyOf: [{ type: 'string', minLength: 1, maxLength: 500 }, { type: 'number' }] } },
      context: { type: 'string', maxLength: MAX_DECIDE_CONTEXT },
      source: {
        type: 'object',
        properties: { tool: { type: 'string', minLength: 1, maxLength: 100 }, args: { type: 'object' } },
        required: ['tool'],
        additionalProperties: false,
      },
    },
    required: ['question', 'options'],
    additionalProperties: false,
  },
  category: 'think',
  describe: (args) => internal(`Decide${args.source ? ` over ${args.source.tool}` : ''}: ${clip(args.question, 80)}`),
  async run(args, ctx) {
    const options = distinctOptions(args.options);
    if ('error' in options) return failure(options.error);
    const source = args.source ? checkSource(ctx, args.source) : undefined;
    if (source && 'error' in source) return failure(source.error);
    // Without a decision model nothing would answer: the source is not run for nothing.
    if (!ctx.services.decisions.available()) return reply(ctx, args, { confidence: 0, by: 'none' });
    const read = source ? await readSource(ctx, source) : undefined;
    if (read && 'error' in read) return failure(read.error);
    if (ctx.signal.aborted) return failure(STOPPED);
    const context = [args.context?.trim(), read ? `Output of ${read.name}:\n${read.text}` : undefined].filter(Boolean).join('\n\n');
    const result = await ctx.services.decisions.decide({
      type: 'choice', purpose: 'agent', question: args.question, options: options.list, context: context || undefined, timeoutMs: DECIDE_TIMEOUT_MS, signal: ctx.signal,
    });
    if (ctx.signal.aborted) return failure(STOPPED);
    return reply(ctx, args, result, read?.name);
  },
});

/** Trimmed options without repeats, or why not: options that differ only in case could never both be picked (the hub matches case-insensitively). */
function distinctOptions(given: Array<string | number>): { list: string[] } | { error: string } {
  const seen = new Map<string, string | number>();
  for (const value of given) {
    const option = String(value).trim();
    if (!option) continue;
    const earlier = seen.get(option.toLowerCase());
    const original = typeof value === 'number' ? value : option;
    if (earlier === undefined) seen.set(option.toLowerCase(), original);
    else if (typeof earlier !== typeof original) return { error: `The number ${option} and text "${option}" have the same label. Make the options distinct.` };
    else if (earlier !== original) return { error: `"${clip(String(earlier), 80)}" and "${clip(option, 80)}" differ only in case, so the decision model cannot tell them apart. Make the options distinct.` };
  }
  if (seen.size < 2) return { error: 'Give at least two different options.' };
  if (seen.has(NONE_OPTION)) return { error: `Leave out "${NONE_OPTION}": the decision model can always answer that none of the options fits.` };
  return { list: [...seen.values()].map(String) };
}

/** The source as the registry names it, or why it cannot be one – judged without running it. */
function checkSource(ctx: ToolContext, source: Source): Checked | { error: string } {
  const name = registryName(ctx, source.tool);
  const tool = ctx.services.tools.get(name);
  if (!tool) return { error: `Unknown source tool "${clip(source.tool, 100)}". Name a read tool I can use, e.g. files.list.` };
  if (tool.category !== 'read') return { error: `${name} cannot be a source: a source only reads (its category is ${tool.category}). I call it myself if I need it.` };
  if (!offered(ctx, name)) return { error: `Tool "${name}" is not available in mode "${ctx.mode}", so it cannot be a source.` };
  const args = source.args ?? {};
  const errors = validate(args, tool.inputSchema);
  if (errors.length) return { error: `Invalid arguments for the source ${name}:\n${errors.join('\n')}` };
  try { tool.describe?.(args, ctx); } catch (error) { return { error: `Invalid arguments for the source ${name}: ${toErrorData(error).message}` }; }
  return { name, args };
}

/** Is the tool offered to this agent in this mode? Same rule as registry.call (no mode known → the registry judges). */
function offered(ctx: ToolContext, name: string): boolean {
  let mode: ModeInfo | undefined;
  try { mode = ctx.services.modes.get(ctx.mode); } catch { return true; }
  return !mode || ctx.services.tools.specsFor(ctx.agent, mode, ANY_ENGINE).some((spec) => spec.name === name);
}

/** Runs the checked source through the registry (offer, journal); its text, or why not. */
async function readSource(ctx: ToolContext, source: Checked): Promise<{ name: string; text: string } | { error: string }> {
  const { services, ...base } = ctx;
  const output = await services.tools.call(source.name, source.args, base, `decide-${randomUUID()}`);
  if (output.isError) return { error: `The source ${source.name} gave no output for the decision: ${clip(outputText(output), 300)}` };
  return { name: source.name, text: outputText(output) };
}

/** The registry name for what the agent wrote: dotted, its wire form (files__list) or mcp__workforce__files__list. */
function registryName(ctx: ToolContext, given: string): string {
  const qualified = `mcp__${MCP_SERVER_NAME}__`;
  const bare = given.startsWith(qualified) ? given.slice(qualified.length) : given;
  return ctx.services.tools.get(bare) ? bare : bare.replaceAll('__', '.');
}

/** The agent's answer – never the context or the source's output – and the run note (`ran`: the source that ran). */
function reply(ctx: ToolContext, args: DecideArgs, result: DecisionResult, ran?: string): ToolOutput {
  const outcome = outcomeOf(result);
  const confidence = Math.round(Math.max(0, Math.min(1, result.confidence)) * 100) / 100;
  const pick = args.options.find((option) => typeof option === 'number' && String(option) === result.choice) ?? result.choice;
  const choice = outcome === 'choice' ? pick : undefined;
  const leaning = outcome === 'unsure' ? pick : undefined;
  note(ctx, { question: preview(ctx.services.secrets, args.question, 300), outcome, by: result.by, confidence, ...(choice !== undefined ? { choice } : {}), ...(ran ? { source: ran } : {}) });
  if (outcome !== 'unsure') return json({ outcome, ...(choice !== undefined ? { choice } : {}), confidence, by: result.by });
  const why = result.by === 'none' ? 'No decision model answered. ' : result.by === 'timeout' ? 'The decision model did not answer in time. ' : '';
  return json({ outcome, confidence, by: result.by, ...(leaning !== undefined ? { leaning } : {}), hint: `${why}${args.source ? UNSURE_SOURCE_HINT : UNSURE_HINT}` });
}

function note(ctx: ToolContext, decision: Record<string, unknown>): void {
  try { ctx.services.runs.item(ctx.runId, { kind: 'note', name: DECIDE_TOOL, data: { decision }, effectStatus: 'none' }); } catch { /* the journal is best effort */ }
}

export const decideTools: ToolDef[] = [decide];
