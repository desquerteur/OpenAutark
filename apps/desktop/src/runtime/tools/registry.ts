// The tool registry: one list of workforce tools exposed identically to every engine. B-072: shell.exec and
// secrets.run start in the CLI engines' env (builtin/command.ts → engines/wf-shim.ts agentEnv), so `wf` is the app's
// client for API-key and local agents too.
// Owns: registration (remote tools get the optional `device` argument), the per-agent/per-mode offer (deterministic
// order for prompt caching) and the one call path: validate → place (device → linked PC, placement.ts) → run here or
// on a linked device → redact/truncate (outputs.ts) → journal (journal.ts) with an idempotency key (a resend of a running call id gets its result; one cut off before
// its result is told so). Each call with an id is reported to the turn's tool boundary (onCall start/end).
// A tool is offered when its mode fits: the mode's tool patterns, or EVERY_MODE, or anyMode (a connector's tools and a few like spend.note);
// `requires: 'device'` keeps the device tools to modes that work on a computer or browser (or name the tool).
// B-049 F4: offerFor/callThrough serve the meta layer (tools/core-sets.ts, learned.ts, builtin/tools-meta.ts).
// Owner 29.10.2026: every string argument passes the leak redactor first (secrets/guard.ts), so a stored secret value
// is never written into a note, memory, file or message – it arrives as its handle.
// B-075: a call with `company` (tools.call's own, or in the arguments: placement.ts placeCompany) runs in that company's
// runtime on this PC: journaled here as an external effect (a break-off leaves it unknown), its summary and result name
// the company, the run there is that runtime's companies.tool (builtin/companies.ts runCompanyTool) over loopback
// (root/companies.ts callCompany).
// Never: retries external effects, puts secret values or HIDDEN_ARGS into outputs or the journal, or forwards a call
// to a revoked, unknown or non-PC device.

import type { RuntimeServices, ToolRegistry } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { ModeInfo } from '../../shared/model/knowledge.ts';
import { toErrorData, WorkforceError } from '../../shared/errors.ts';
import type { ActionDescription, ToolContext, ToolDef, ToolOutput, ToolSpec } from './types.ts';
import { DEVICE_ARG, failure } from './types.ts';
import { inCompany, isRecord, onPc, place, placeCompany, safeSelfId, withDeviceArg, type CompanyTarget } from './placement.ts';
import { callCompany } from '../root/companies.ts';
import { validate } from './validate.ts';
import { finalizeOutput, preview } from './outputs.ts';
import { cachedResult, journalArgs, journalResult, journaled, safeItem, safeUpdate } from './journal.ts';
import { CALL_TOOL, coreNames } from './core-sets.ts'; // B-049 F4
import { noteLearned } from './learned.ts'; // B-049 F4
import { callRefusal, callTarget } from './builtin/tools-meta.ts'; // B-049 F4
import { withoutSecretValues } from '../secrets/guard.ts';

export { resolveDevice, withDeviceArg, type DeviceTarget } from './placement.ts';

export interface ToolRegistryOptions {
  /** Late-bound: the registry is itself part of RuntimeServices. */
  services: () => RuntimeServices;
  /** Hook when a call with a call id starts (true) and ends (false): the turn's tool boundaries (agents/dispatch-boundary.ts). */
  onCall?(ctx: { agentId: string; runId: string; callId: string }, running: boolean): void;
}

/** '*' = everything, 'tasks.*' prefix globs, '!name' excludes. Last matching pattern wins. */
export function matchesPatterns(name: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return true;
  let allowed = false;
  for (const raw of patterns) {
    const negate = raw.startsWith('!');
    const pattern = negate ? raw.slice(1) : raw;
    const regex = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    if (regex.test(name)) allowed = !negate;
  }
  return allowed;
}

/** Offered in every mode, whatever its tool patterns: asking the person, handing work on, self-routing, reporting,
 *  handing a choice to the decision model, the secrets catalog (save, generate, run, import, export, delete), the
 *  companies on this PC, finding knowledge and the person's references, the web search, splitting, the meta tools,
 *  seeing an image and starting a CLI sign-in. */
export const EVERY_MODE: ReadonlySet<string> = new Set([
  'human.ask', 'agents.handoff', 'agents.delegate', 'model.set', 'models.list', 'feedback.report', 'decide',
  'references.find', 'references.capture',
  'secrets.list', 'secrets.save', 'secrets.generate', 'secrets.run', 'secrets.import', 'secrets.export', 'secrets.delete',
  'companies.list',
  'knowledge.find', 'knowledge.open', 'skills.load', 'skills.find',
  'web.search',
  'tools.find', 'tools.call',
  'agents.split', 'agents.split_results', 'agents.split_stop', 'agents.split_merge',
  'media.view', 'accounts.sign_in', 'telegram.connect',
]);

/** Arguments the journal never shows (a phone's pairing code is a one-time secret; a secret's value). */
export const HIDDEN_ARGS: ReadonlyMap<string, readonly string[]> = new Map([['phone.pair', ['code']], ['decide', ['context']], ['secrets.save', ['value']]]);

/** Arguments that go straight into the vault: the leak guard (secrets/guard.ts) leaves them as given. */
export const VAULT_ARGS: ReadonlyMap<string, readonly string[]> = new Map([['secrets.save', ['value']]]);

const CUT_OFF = 'This call already started earlier, but no result was recorded (it was probably cut off), so whether it had an effect is unknown. I check that before doing it again.';

export class Registry implements ToolRegistry {
  private tools = new Map<string, ToolDef>();
  private options: ToolRegistryOptions;
  /** Calls running in this process by idempotency key (a resend gets the same result). */
  private readonly running = new Map<string, Promise<ToolOutput>>();

  constructor(options: ToolRegistryOptions) {
    this.options = options;
  }

  register(tool: ToolDef): void {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(tool.name)) throw new Error(`Invalid tool name: ${tool.name}`);
    this.tools.set(tool.name, withDeviceArg(tool));
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  all(): ToolDef[] {
    return [...this.tools.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Is `tool` offered in `mode`? (Same rule for the offer and for calls.) */
  allowed(tool: ToolDef, _agent: Agent, mode: ModeInfo): boolean {
    if (tool.modes && !tool.modes.includes(mode.key)) return false;
    if (!EVERY_MODE.has(tool.name) && !tool.anyMode && !matchesPatterns(tool.name, mode.tools)) return false;
    if (tool.requires === 'device') return mode.workspace === 'computer' || mode.workspace === 'browser' || (mode.tools ?? []).some((pattern) => pattern !== '*' && matchesPatterns(tool.name, [pattern]));
    return true;
  }

  specsFor(agent: Agent, mode: ModeInfo, engine?: { ownTools: boolean; via: 'mcp' | 'native' }): ToolSpec[] {
    return this.all()
      .filter((tool) => this.allowed(tool, agent, mode))
      .filter((tool) => {
        if (!engine) return tool.audience === undefined;
        if (tool.audience === 'http') return !engine.ownTools;
        if (tool.audience === 'mcp') return engine.via === 'mcp';
        return true;
      })
      .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
  }

  /** B-049 F4: the engine's direct offer – the mode's core set, `learned` and the meta tools, out of specsFor (same order). */
  offerFor(agent: Agent, mode: ModeInfo, engine: { ownTools: boolean; via: 'mcp' | 'native' }, learned: readonly string[] = []): ToolSpec[] {
    const direct = coreNames(mode, engine);
    for (const name of learned) direct.add(name);
    return this.specsFor(agent, mode, engine).filter((spec) => direct.has(spec.name));
  }

  /** `company`: tools.call's own `company` (B-075), apart from the target's arguments. */
  async call(name: string, args: unknown, base: Omit<ToolContext, 'services'>, callId: string, company?: unknown): Promise<ToolOutput> {
    if (name === CALL_TOOL) return this.callThrough(args, base, callId); // B-049 F4
    const services = this.options.services();
    const ctx: ToolContext = { ...base, services, callId: callId || undefined }; // a nested call never inherits its caller's id
    const tool = this.tools.get(name);
    if (!tool) return failure(`Unknown tool "${name}". Use one of the listed tools.`);

    let mode: ModeInfo | undefined;
    try { mode = services.modes.get(ctx.mode); } catch { mode = undefined; }
    if (mode && !this.allowed(tool, ctx.agent, mode)) return failure(`Tool "${name}" is not in mode "${ctx.mode}".`);

    const placedIn = placeCompany(services, tool, args, company); // B-075: `company` – another company of this PC runs it
    if ('error' in placedIn) return failure(placedIn.error);
    const errors = validate(placedIn.input, tool.inputSchema);
    if (errors.length) {
      const stray = !tool.remote && isRecord(placedIn.input) && Object.hasOwn(placedIn.input, DEVICE_ARG) && errors.some((line) => line.startsWith(`${DEVICE_ARG}:`));
      return failure(stray ? `${name} always runs on this PC, so it takes no "${DEVICE_ARG}".` : `Invalid arguments for ${name}:\n${errors.join('\n')}`);
    }
    const fields = (placedIn.input ?? {}) as Record<string, unknown>;
    const placed: ReturnType<typeof place> = placedIn.target ? { input: fields } : place(services, tool, fields, ctx); // in another company, that one places it
    if ('error' in placed) return failure(placed.error);
    const { target } = placed;
    const input = withoutSecretValues(services.secrets, placed.input, VAULT_ARGS.get(name)); // owner 29.10.2026 (secrets/guard.ts)

    // Idempotency: the same (run, call id) never executes twice (engine retries, reconnects): a
    // resend while it runs gets its result; one whose result was never journaled is told so.
    const idemKey = `${ctx.runId}:${callId}`;
    const running = this.running.get(idemKey);
    if (running) return running;
    const cached = cachedResult(services, `${idemKey}:result`);
    if (cached) return cached;
    if (journaled(services, idemKey)) return failure(CUT_OFF);

    let action: ActionDescription = { summary: name, external: false };
    if (tool.describe) {
      try { action = tool.describe(input, ctx); } catch (error) {
        if (!placedIn.target) return failure(`Invalid arguments for ${name}: ${toErrorData(error).message}`); // in another company its describe read this one's data
      }
    }
    if (target) action = onPc(action, target);
    if (placedIn.target) action = inCompany(action, placedIn.target); // judged external there: its effect is that company's

    // The turn's tool boundary follows this call under its id from here (a resend above is the same call).
    const report = (on: boolean) => { if (callId) { try { this.options.onCall?.({ agentId: ctx.agent.id, runId: ctx.runId, callId }, on); } catch { /* bookkeeping only */ } } };
    report(true);
    const call = this.invoke(services, { tool, args: input, action, ctx, company: placedIn.target }, callId, idemKey, target?.name);
    this.running.set(idemKey, call);
    try { return await call; } finally { this.running.delete(idemKey); report(false); }
  }

  /**
   * B-049 F4 tools.call: its target runs through call() under the target's own name and this call id – the same
   * validation, journal and result as a direct call (tools-meta.ts callRefusal); a target outside the mode's core
   * set is noted for the next fresh session.
   */
  private async callThrough(args: unknown, base: Omit<ToolContext, 'services'>, callId: string): Promise<ToolOutput> {
    const services = this.options.services();
    const target = callTarget(args);
    if ('error' in target) return failure(target.error);
    const refused = callRefusal({ ...base, services, callId: callId || undefined }, target.name);
    if (refused) return failure(refused);
    try {
      if (!base.split && !coreNames(services.modes.get(base.mode)).has(target.name)) noteLearned(services, base.agent.id, base.conversationId, target.name); // B-057 S9: a split learns no tools
    } catch { /* unknown mode or no store: nothing learned, the call still runs */ }
    return this.call(target.name, target.args, base, callId, target.company);
  }

  /** run → journal, for a call id that has not started before. */
  private async invoke(services: RuntimeServices, call: { tool: ToolDef; args: Record<string, unknown>; action: ActionDescription; ctx: ToolContext; company?: CompanyTarget }, callId: string, idemKey: string, device?: string): Promise<ToolOutput> {
    const { tool, args: input, action, ctx, company } = call;
    const name = tool.name;
    // Summaries are redacted too: a tool may echo a filled value.
    const callData = { callId, args: preview(services.secrets, journalArgs(input, HIDDEN_ARGS.get(name))), summary: preview(services.secrets, action.summary), category: tool.category, ...(device ? { device } : {}) };
    const callItem = safeItem(services, ctx.runId, { kind: 'tool_call', name, data: callData, effectStatus: action.external ? 'pending' : 'none', idemKey });
    const started = Date.now();
    let output: ToolOutput;
    try {
      output = company ? await forward(company, tool, input, ctx) : await this.execute(tool, input, ctx);
    } catch (error) {
      // A throw after an external call started may still have had an effect: never retry blindly.
      output = { ...failure(toErrorData(error).message), effect: action.external ? { status: 'unknown' } : undefined };
    }
    const { output: finalOutput, blobIds } = await finalizeOutput(output, services, name);
    if (callItem && action.external) {
      const status = finalOutput.effect?.status ?? (finalOutput.isError ? 'failed' : 'confirmed');
      safeUpdate(services, callItem, { effectStatus: status, data: { ...callData, ms: Date.now() - started, externalId: finalOutput.effect?.externalId } });
    }
    journalResult(services, ctx.runId, name, callId, idemKey, finalOutput, blobIds);
    return finalOutput;
  }

  private async execute(tool: ToolDef, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
    const remote = ctx.deviceId !== undefined && tool.remote && ctx.deviceId !== safeSelfId(ctx.services);
    if (!remote) return normalizeOutput(await tool.run(input, ctx));
    // Nothing ran there when the dial failed or was stopped (reachable: false) or that PC refused the call before
    // its tool ran (PEER_REFUSALS): a plain failure, never unknown.
    let result: unknown;
    try {
      result = await ctx.services.devices.call(ctx.deviceId!, 'tools.call', {
        name: tool.name, args: input, agentId: ctx.agent.id, agentName: ctx.agent.name, runId: ctx.runId,
        conversationId: ctx.conversationId, taskId: ctx.taskId, mode: ctx.mode,
      }, ctx.signal);
    } catch (error) {
      if (!nothingRan(error)) throw error;
      return failure(error.message);
    }
    return normalizeOutput(result);
  }
}

const PEER_REFUSALS: ReadonlySet<string> = new Set(['forbidden', 'bad_request']); // that PC's or company's checks and arguments (devices/tools.ts, builtin/companies.ts)

/** Nothing ran there: the call never reached it (reachable: false) or it refused before its tool ran (PEER_REFUSALS). */
const nothingRan = (error: unknown): error is WorkforceError => error instanceof WorkforceError && (error.details?.reachable === false || PEER_REFUSALS.has(error.code));

/** B-075: runs a call in another company's runtime on this PC (its companies.tool); the result names that company. */
async function forward(company: CompanyTarget, tool: ToolDef, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  let result: unknown;
  try {
    result = await callCompany(company.dir, 'companies.tool', {
      name: tool.name, args: input, agentId: ctx.agent.id, agentName: ctx.agent.name, runId: ctx.runId, mode: ctx.mode, from: company.from,
    }, { signal: ctx.signal });
  } catch (error) {
    if (!nothingRan(error)) throw error;
    return failure(`${company.name}: ${error.message}`);
  }
  const output = normalizeOutput(result);
  return { ...output, content: [{ type: 'text', text: `In ${company.name}:` }, ...output.content] };
}

/** Accepts plain strings or partial outputs from tools/devices and returns a valid ToolOutput. */
export function normalizeOutput(value: unknown): ToolOutput {
  if (typeof value === 'string') return { content: [{ type: 'text', text: value }] };
  if (value && typeof value === 'object' && Array.isArray((value as ToolOutput).content)) return value as ToolOutput;
  return { content: [{ type: 'text', text: JSON.stringify(value ?? null) }], structured: value };
}
