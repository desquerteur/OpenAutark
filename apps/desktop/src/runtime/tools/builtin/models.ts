// Model knowledge and self-routing for agents (RT4, RT2): models.list compares the models the calling
// agent may use for a kind of work (routing/model-list.ts; decisions and embeddings: what answers them now and the
// models made for them), and a manager can pick a pin for
// agents.update; model.set (moved here from skills.ts, B-048) asks for the next step's or the task's model.
// Both are core tools (tools/registry.ts), offered in every mode.
// B-048 E4.2 – model by need: model.set takes a need (stronger, cheaper, faster, vision, long_context –
// routing/need.ts) or a concrete model, and/or an effort. A need is resolved by the router (a preview
// route like the next turn's, the decision model breaking near-ties) and the answer names the model it
// will be; the request keeps the need, the model it ran on and that model (agents/next-route.ts), so
// the turn's router resolves it again within the same bounds. now: true ends the turn at the next tool
// boundary and continues at once on the new route (Dispatcher.continueNow: the urgent interrupt path).
// B-078 (D16): model.set also takes a temperature (0..2), kept like the effort (agents/next-route.ts) and sent by the
// engines that take one (http/compatible.ts always, http/openai.ts and http/anthropic.ts on models without reasoning or
// thinking – engines/http/temperature.ts); the description says plainly where it reaches.
// Owns: the models.list and model.set definitions. Never: changes routing state beyond the agent's own
// request, lists or picks chat models outside the calling agent's model policy band, or cuts a turn without now.

import type { ToolContext, ToolDef } from '../types.ts';
import { failure, json, text } from '../types.ts';
import type { RouteRequest } from '../../contracts.ts';
import type { ModeInfo } from '../../../shared/model/knowledge.ts';
import type { Effort, RouteDecision } from '../../../shared/model/providers.ts';
import { CATEGORIES } from '../../models/priors.ts';
import { categoryLabel } from '../../routing/categories.ts';
import { modelList } from '../../routing/model-list.ts';
import { MODEL_NEEDS, NO_FIT_TEXT, needMet, type ModelNeed } from '../../routing/need.ts';
import { setNextRoute, setTaskRoute, type NextRoute } from '../../agents/next-route.ts';
import { takesTemperature } from '../../engines/http/temperature.ts';
import { clip, defineTool, internal } from './util.ts';

const listModels = defineTool<{ category?: string; includeUnavailable?: boolean }>({
  name: 'models.list',
  description: 'Compare the models I can use (inside my model policy), best first for a kind of work as routing ranks them: id, name, tier, source (plan, API key or local), efforts, fit for that work (without category also each model\'s strong and weak kinds of work), list price per 1M tokens and smarts (overall capability 0–100). category: the kind of work (default: my current mode\'s); "decision" and "embeddings" say what answers that use now and list the connected models made for it. includeUnavailable: also the models that cannot run right now (no usable account, limits) with the reason (not for "decision" and "embeddings"). Ask for one with model.set.',
  inputSchema: {
    type: 'object',
    properties: { category: { type: 'string', enum: [...CATEGORIES] }, includeUnavailable: { type: 'boolean' } },
    additionalProperties: false,
  },
  category: 'read',
  describe: (args) => internal(`List models${args.category ? ` for ${categoryLabel(args.category)}` : ''}`),
  async run(args, ctx) {
    const catalog = ctx.services.catalog;
    // Fresh install: the catalog may not be built yet (refresh is coalesced and throttled).
    if (!catalog.list().some((model) => model.available)) await catalog.refresh().catch(() => undefined);
    let mode: Pick<ModeInfo, 'category' | 'minTier'>;
    try { mode = ctx.services.modes.get(ctx.mode); } catch { mode = { category: 'chat' }; }
    return text(modelList({
      services: ctx.services, agent: ctx.agent, conversationId: ctx.conversationId, mode,
      category: args.category, includeUnavailable: args.includeUnavailable,
    }));
  },
});

const EFFORTS: Effort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const NEED_WORDS: Record<ModelNeed, string> = { stronger: 'a stronger model', cheaper: 'a cheaper model', faster: 'a faster model', vision: 'a model that reads images', long_context: 'a longer context' };

interface SetArgs { model?: string; need?: ModelNeed; effort?: Effort; temperature?: number; for?: 'next_step' | 'task'; now?: boolean; reason?: string }

/** The fact line of model.set about where a temperature reaches (first person, no rule; engines/http/temperature.ts decides per model). */
export const TEMPERATURE_FACT = 'temperature (0–2) reaches local and OpenAI-compatible models (Ollama, LM Studio, OpenRouter, Gemini, xAI, DeepSeek, Groq keys), OpenAI API models without reasoning and Anthropic API models without thinking (there at most 1); Claude Code, Codex, the other CLIs and the reasoning and thinking models keep their own, so there I set the tone with my wording';

/** What the calling run runs on now (the dispatcher's activity, B-048 E4.5), else the tool context's model. */
function current(ctx: ToolContext): { modelId?: string; effort?: Effort } {
  let row: { model?: string; effort?: Effort } | undefined;
  try { row = ctx.services.dispatcher?.activity().find((item) => item.runId === ctx.runId); } catch { row = undefined; }
  return { modelId: ctx.modelId ?? row?.model, effort: row?.effort };
}

/** The route the agent's next turn would take for this need: the router's own rules, one preview (no state changes). */
async function previewNeed(ctx: ToolContext, args: SetArgs & { need: ModelNeed }, from: { modelId?: string; effort?: Effort }): Promise<RouteDecision> {
  let mode: ModeInfo;
  try { mode = ctx.services.modes.get(ctx.mode); } catch { mode = { key: ctx.mode, category: 'chat' } as ModeInfo; }
  let task: { title: string; notes: string } | undefined;
  try { task = ctx.taskId ? ctx.services.tasks.get(ctx.taskId) : undefined; } catch { task = undefined; }
  const previous: NonNullable<RouteRequest['previous']> = {
    modelId: from.modelId ?? '', effort: args.effort ?? from.effort ?? 'medium', explicit: true, ...(args.effort ? {} : { asked: 'model' as const }),
    need: { kind: args.need, ...(from.modelId ? { from: from.modelId } : {}) },
  };
  return ctx.services.router.route({
    agent: ctx.agent, conversationId: ctx.conversationId, taskId: ctx.taskId, mode, ...(task ? { text: `${task.title}\n${task.notes}` } : {}), previous,
  });
}

const setModel = defineTool<SetArgs>({
  name: 'model.set',
  description: `Say what model my work needs – routing picks it within my model policy: a need, or a model id from models.list, and/or an effort, and/or a temperature (low for exact work like code, higher for human-sounding text and wide ideas). ${TEMPERATURE_FACT}. for: "next_step" (default: next turn only) or "task" (every turn until my current task is done). now: true – my turn ends after this call; my work continues at once on the new model.`,
  inputSchema: {
    type: 'object',
    properties: {
      need: { type: 'string', enum: [...MODEL_NEEDS] }, model: { type: 'string' }, effort: { type: 'string', enum: EFFORTS },
      temperature: { type: 'number', minimum: 0, maximum: 2 },
      for: { type: 'string', enum: ['next_step', 'task'] }, now: { type: 'boolean' }, reason: { type: 'string', maxLength: 300 },
    },
    additionalProperties: false,
  },
  category: 'think',
  describe: (args) => internal(`${args.for === 'task' ? 'This task' : 'Next step'} on ${args.need ? NEED_WORDS[args.need] ?? args.need : args.model ?? 'same model'} ${args.effort ?? ''}${args.temperature !== undefined ? ` temperature ${args.temperature}` : ''}${args.now ? ' now' : ''}`.replace(/\s+/g, ' ').trim()),
  async run(args, ctx) {
    if (args.model && args.need) return failure('Give a need or a model, not both.');
    if (!args.model && !args.need && !args.effort && args.temperature === undefined) return failure('Give a need, a model, an effort and/or a temperature.');
    if (args.temperature !== undefined && (typeof args.temperature !== 'number' || !Number.isFinite(args.temperature) || args.temperature < 0 || args.temperature > 2)) return failure('temperature is a number from 0 to 2.');
    const taskId = args.for === 'task' ? ctx.taskId : undefined;
    if (args.for === 'task') {
      const status = taskId ? ctx.services.tasks.get(taskId)?.status : undefined;
      if (!taskId || !status) return failure('This turn has no task – use for: "next_step".');
      if (status === 'done' || status === 'cancelled') return failure('This task is finished – use for: "next_step".');
    }
    const policy = ctx.agent.modelPolicy;
    const from = current(ctx);
    let modelId: string | undefined;
    let effort = args.effort;
    let shown = args.effort; // the effort the answer names (a need's preview route says it)
    if (args.model) {
      const info = ctx.services.catalog.get(args.model) ?? ctx.services.catalog.list().find((model) => model.model === args.model || model.name === args.model);
      if (!info) return failure(`Unknown model "${args.model}". Known: ${ctx.services.catalog.list().filter((model) => model.available).slice(0, 12).map((model) => model.id).join(', ')}`);
      if (!info.available) return failure(`${info.name} has no usable account right now.`);
      if (policy.pin && policy.pin !== info.id) return failure('My model is pinned by my manager.');
      if (policy.avoid?.includes(info.id)) return failure(`${info.name} is excluded by my model policy.`);
      if (args.effort && !info.efforts.includes(args.effort)) return failure(`${info.name} supports efforts: ${info.efforts.join(', ')}.`);
      modelId = info.id;
    } else if (args.need) {
      if (policy.pin) return failure('My model is pinned by my manager.');
      let route: RouteDecision;
      try { route = await previewNeed(ctx, { ...args, need: args.need }, from); } catch (error) {
        return failure(`No model can run this right now: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (route.by === 'pin') return failure(`My model is ${route.reason.split(' · ')[0]} – model.set cannot change it.`);
      const stay = ctx.services.catalog.get(from.modelId ?? '')?.name ?? 'my current model';
      if (!needMet(route.reason, args.need)) return failure(`${capital(NO_FIT_TEXT[args.need])} within my model policy right now – I stay on ${stay}. Ask for an effort instead, or name a model from models.list.`);
      modelId = route.modelId;
      shown = route.effort;
      effort = args.effort ?? (route.modelId === from.modelId ? route.effort : undefined); // stronger without a stronger model: one effort step up, kept as asked
    }
    const value: NextRoute = {
      ...(modelId ? { modelId } : {}), ...(effort ? { effort } : {}), ...(args.need ? { need: args.need, ...(from.modelId ? { from: from.modelId } : {}) } : {}),
      ...(args.reason ? { reason: clip(args.reason, 300) } : {}), ...(args.temperature !== undefined ? { temperature: args.temperature } : {}), at: ctx.services.clock.now(),
    };
    if (taskId) setTaskRoute(ctx.services.db, ctx.agent.id, ctx.conversationId, taskId, value);
    else setNextRoute(ctx.services.db, ctx.agent.id, ctx.conversationId, value);
    const info = modelId ? ctx.services.catalog.get(modelId) : undefined;
    const name = info?.name ?? (from.modelId ? ctx.services.catalog.get(from.modelId)?.name : undefined);
    const switched = args.now ? switchNow(ctx, `${name ?? 'the requested model'}${shown ? ` · ${shown}` : ''}`) : false;
    const target = modelId ? info : from.modelId ? ctx.services.catalog.get(from.modelId) : undefined;
    return json({
      ok: true, ...(name ? { model: name } : {}), ...(modelId ? { modelId } : {}), ...(shown ? { effort: shown } : {}),
      ...(args.temperature !== undefined ? { temperature: args.temperature, ...(target && !takesTemperature(target.engine, target.model) ? { temperatureNote: `${name ?? 'This model'} keeps its own temperature – ${TEMPERATURE_FACT}.` } : {}) } : {}),
      appliesTo: taskId ? `every turn on task ${taskId} until it is done` : 'next turn',
      ...(args.now ? { now: switched ? 'my turn ends after this call and continues at once on this model' : 'cannot switch inside this turn – it applies from my next turn' } : {}),
      ...(args.need && info && from.modelId === info.id ? { stays: `${capital(NO_FIT_TEXT[args.need])}: I stay on ${info.name}${effort ? ` at effort ${effort}` : ''}.` } : {}),
    });
  },
});

function capital(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** now: true – the dispatcher cuts this turn at its next tool boundary and runs its chat (task) again at once. */
function switchNow(ctx: ToolContext, target: string): boolean {
  try {
    return ctx.services.dispatcher?.continueNow?.(ctx.agent.id, ctx.runId, `I switched to ${target} (model.set now) – I continue my work where I stopped; what I did so far is kept.`) ?? false;
  } catch {
    return false;
  }
}

export const modelTools: ToolDef[] = [listModels, setModel];
