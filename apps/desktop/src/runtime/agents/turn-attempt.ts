// Turn phase 2 – one engine attempt: wires engine.run to our tools (dynamic tools or the
// MCP hub lease), streaming deltas into the chat
// message, live status, usage, account limits and the run journal for engine-own tools.
// D5: reasoning is journaled live per block (reasoning-log.ts) and its headline is the live status;
// an engine-native call is journaled with its human line (shared/text/step-label.ts: summary + step),
// which is also the live status while it runs (the engine's raw "running <cmd>" line is dropped then).
// Owns: the EngineTurnInput callbacks, admission (heavy slot while a CLI engine runs) and the
// latest input coordinates for interruption context (interruption-context.ts),
// tool-call count failover relies on (engine-own, callTool and MCP hub calls) and whether each
// call succeeded (ours: its output, else tool_end; engine-native ones: tool_end – the progress signal), and each call's start and
// end for the dispatcher's tool boundaries (request.onTool, agents/dispatch-boundary.ts: engine-native
// calls by the engine's id; our calls under the registry's id – callTool here, MCP hub calls through
// the registry's onCall, so the engine's tool_start for them is not counted twice under another id).
// An abort releases the MCP lease at once, so a hub
// call arriving after a cut never starts (B-059: nor a callTool call). The dynamic tool
// list comes with the routed turn (buildTurn computes the offer the prompt key covers).
// The engine's folder is the task's active worktree (git/records.ts turnCwd), else the agent's home project (B-044), else the workspace.
// B-044 stall watchdog (stall-watch.ts): an engine quiet for 10 min (45 min while a tool call runs) is cut
// and the attempt ends 'unavailable' ("The
// engine stopped responding."), so turn.ts's failover applies; a run note records the cut.
// B-048 E1 (LEDGER): the attempt names its run to the context ledger (services.ledger.capture – the chat lines its
// input shows, then the run's journal items, become ledger items); an engine-native call's full output
// (tool_end.output, redacted) is journaled with its result, so the ledger can restore and replay it. B-049 F9: an
// engine-native call made inside a code-mode script is journaled with `nested` (and its script's id as `parent`).
// The attempt names its run to the context ledger (the chat lines its input shows, then the run's journal items, become ledger
// items) and journals the subconscious's calls of this turn as real calls with their outputs (journalTrace), so they stay in the
// ledger and in a rebuilt history; an engine that cannot show them natively gets them as a block in the input (engines/trace-text.ts).
// B-054: our tools see what started the run (ToolContext.origin, the wake group's) and the first line of an app-written
// wake note (ToolContext.wakeNote, at most WAKE_NOTE_MAX characters; only an outside event's ('event') own note, never a
// schedule, retry, review or message note – dispatch-groups.ts originNote).
// B-057 (agents/split-turn.ts): a split's calls carry ToolContext.split (also through the hub lease); its engine runs in its
// worktree or its group's folder; on a Codex app-server it takes no heavy supervisor slot
// (S12 – the process is shared), a cold one's only while that server starts (split-admit.ts).
// B-059 #184: a provider's transient failure (an engine timeout, a cloud provider's HTTP 500/502/504 – never a local
// runtime's) ends the attempt 'unavailable' – an outage of the account, not of the model (engines/provider-outage.ts
// providerOutage), so turn.ts's cooling and failover apply.
// B-059 #182: an engine-native tool_result
// is journaled with its call's tool name (by call id), so the readers of the journal see which native call failed.
// Never: decides failover or integrates the result (turn.ts / turn-finish.ts do).

import type { RuntimeServices } from '../contracts.ts';
import type { EngineEvent, EngineTurnResult } from '../engines/types.ts';
import { addCache } from '../engines/shared.ts';
import { WAKE_NOTE_MAX, failure, type ToolContext } from '../tools/types.ts';
import { toErrorData, WorkforceError } from '../../shared/errors.ts';
import { preview } from '../tools/outputs.ts';
import { turnCwd } from '../git/records.ts';
import { accountFailure } from '../accounts/failure.ts';
import { providerOutage } from '../engines/provider-outage.ts'; // B-059 #184
import { StallWatch } from './stall-watch.ts';
import { ReasoningLog } from './reasoning-log.ts';
import { stepLabel, stepText } from '../../shared/text/step-label.ts';
import { calledTool } from '../tools/builtin/tools-meta.ts'; // B-049 F4 (TOOLS-CORE)
import type { AttemptResult, RoutedTurn, ToolUse, TurnPlan, TurnRequest } from './turn-types.ts';
import { splitCwd } from './split-turn.ts'; // B-057
import { admitAttempt } from './split-admit.ts'; // B-057 S12: the heavy slot (a split's only while a Codex app-server starts)
import { traceCallId } from '../../shared/model/subconscious.ts';
import { traceInput } from '../engines/trace-text.ts';
import { recordTurnInput } from './interruption-context.ts';
import { runWithNativeTimeouts } from './native-timeout.ts';
import { temperatureOf } from './next-route.ts'; // B-078
import { turnAccessPolicy } from '../access/turn.ts'; // AF-013

/**
 * B-054: the first line of the note of the outside event that started the run (TurnRequest.originNote – only an
 * 'event' wake's, dispatch-groups.ts), cut to WAKE_NOTE_MAX (app text, data only). Never another wake's note of the
 * group: a schedule, retry, review, child, handoff or message note is agent- or system-written.
 */
export function wakeNoteOf(request: Pick<TurnRequest, 'origin' | 'originNote'>): { wakeNote?: string } {
  if (!request.origin || !request.originNote) return {};
  const line = request.originNote.split('\n').map((part) => part.trim()).find(Boolean);
  if (!line) return {};
  return { wakeNote: line.length > WAKE_NOTE_MAX ? `${line.slice(0, WAKE_NOTE_MAX - 1)}…` : line };
}

/** The subconscious's calls in the run's journal, as the calls they are (once per run, also over a failover). Never throws. */
function journalTrace(services: RuntimeServices, plan: TurnPlan, runId: string): void {
  try {
    plan.trace?.calls.forEach((call, index) => {
      const callId = traceCallId(runId, index);
      services.runs.item(runId, { kind: 'tool_call', name: call.tool, idemKey: `${callId}:call`, effectStatus: 'none', data: { callId, args: preview(services.secrets, call.args), summary: `Subconscious: ${call.tool}`, subconscious: true } });
      services.runs.item(runId, { kind: 'tool_result', name: call.tool, idemKey: `${callId}:result`, effectStatus: 'none', data: { callId, ok: true, summary: preview(services.secrets, call.output, 400), output: { content: [{ type: 'text', text: call.output }] } } });
    });
  } catch (error) {
    services.log.warn('journaling the subconscious calls failed', { runId, error: String(error) });
  }
}

export async function runAttempt(services: RuntimeServices, plan: TurnPlan, turn: RoutedTurn, request: TurnRequest, messageId: string | undefined): Promise<AttemptResult> {
  const started = services.clock.now();
  recordTurnInput(services, plan, request, turn.lastSeq);
  const status = (note: string) => { try { request.onStatus?.(note); } catch { /* cosmetic */ } };
  // B-044: the engine and our calls run on the watch's signal (the turn's own abort, or the stall cut).
  const watch = new StallWatch({ now: () => services.clock.now(), parent: request.signal });
  // The routed model of this attempt (a failover brings its own).
  const toolCtx: Omit<ToolContext, 'services'> = {
    agent: plan.agent, runId: request.runId, conversationId: plan.conversationId, taskId: plan.task?.id,
    mode: plan.mode.key, deviceId: plan.agent.deviceId, modelId: turn.route.modelId, signal: watch.signal,
    status: (note) => { watch.activity(); status(note); },
    ...(plan.origin ? { origin: plan.origin } : {}), ...wakeNoteOf(request),
    ...(plan.split ? { split: plan.split } : {}), // B-057 S15: the parent's chat/task for reads
  };
  // A failover attaches again with its own engine and model.
  // The subconscious's calls stand in front of the chat lines of this turn, as the engine's own session holds them (injected before the input).
  const journal = () => journalTrace(services, plan, request.runId);
  if (plan.conversationId && services.ledger?.capture) services.ledger.capture({ runId: request.runId, agentId: plan.agent.id, conversationId: plan.conversationId, engine: turn.engine.id, model: turn.route.modelId, seenSeq: turn.lastSeq, first: journal });
  else journal();
  let streamed = '';
  // D5: reasoning blocks are journaled live, one run item each, between the steps (reasoning-log.ts).
  const thoughts = new ReasoningLog({
    open: (summary) => services.runs.item(request.runId, { kind: 'reasoning', data: { summary, live: true }, effectStatus: 'none' })?.id,
    update: (itemId, data) => services.runs.updateItem(itemId, { data }),
    redact: (text) => services.secrets.redact(text),
    status, now: () => services.clock.now(),
    warn: (message, error) => services.log.warn(message, { runId: request.runId, error: String(error) }),
  });
  let toolCalls = 0;
  const ownCalls = new Set<string>(); // engine-native tool calls (ours are journaled by the registry)
  // Our tools arrive via callTool (dynamic tools / function calls) or through the MCP hub
  // (Claude, ACP agents: only a tool_start with own:false). Both count, once per call id.
  const ourCalls = new Set<string>();
  const used: ToolUse[] = []; // what ran, for the progress signal (turn-types.ts effectful)
  const ourUses = new Map<string, ToolUse>(); // call id → its entry in `used` (ok arrives with the output or tool_end)
  const nativeUses = new Map<string, ToolUse>(); // B-059: engine-native call id → its entry (a failed or declined call is no activity)
  let planSteps: string[] | undefined; // the engine's latest plan
  let planDone: number | undefined; // B-059: how many of its steps are done (an outcome when the same plan finishes more)
  // Tool boundaries for the dispatcher (an urgent interrupt waits until no call is in flight).
  const boundary = (callId: string, running: boolean) => { try { request.onTool?.(callId, running); } catch { /* bookkeeping only */ } };
  const countOurs = (callId: string, name?: string): ToolUse | undefined => {
    if (callId && ourCalls.has(callId)) return ourUses.get(callId);
    if (callId) ourCalls.add(callId);
    toolCalls++;
    const use: ToolUse = { name: name ?? 'tool', category: name ? services.tools.get(name)?.category : undefined, native: false };
    used.push(use);
    if (callId) ourUses.set(callId, use);
    return use;
  };
  const usage: AttemptResult['usage'] = { inputTokens: 0, outputTokens: 0 };

  const onEvent = (event: EngineEvent) => {
    watch.activity();
    try {
      switch (event.type) {
        case 'text':
          if (event.delta) thoughts.close();
          streamed += event.delta;
          if (messageId && event.delta) services.chats.appendDelta(messageId, event.delta);
          break;
        case 'reasoning':
          thoughts.delta(event.delta, event.id);
          break;
        case 'reasoning_end':
          thoughts.end(event.id, event.text);
          break;
        case 'commentary':
          thoughts.close();
          if (event.text.trim()) {
            streamed = ''; // pre-tool text is an update, never the fallback final answer
            services.runs.item(request.runId, { kind: 'note', name: 'Update', data: { text: services.secrets.redact(event.text).slice(0, 4000), commentary: true }, effectStatus: 'none' });
            status(services.secrets.redact(event.text).replace(/\s+/g, ' ').slice(0, 140));
          }
          break;
        case 'plan':
          thoughts.close();
          planSteps = event.steps.map((step) => step.text).filter(Boolean);
          planDone = event.steps.filter((step) => step.text && step.status === 'done').length; // B-059
          services.runs.item(request.runId, { kind: 'plan', data: { steps: event.steps }, effectStatus: 'none' });
          break;
        case 'tool_start': {
          thoughts.close();
          // D5: what the step does in words ("Ran npm test", "Read src/app.ts") – the live status while it runs.
          const shown = event.own ? event : calledTool(event.name, event.args); // B-049 F4: a tools.call shows and counts as the tool it runs
          const step = stepLabel(shown.name, shown.args, { own: event.own, ...(event.title ? { title: event.title } : {}) });
          status(preview(services.secrets, stepText(step, true) || event.name, 140));
          watch.call(event.callId, true);
          if (event.own) {
            boundary(event.callId, true); // ours are reported by the registry (onCall) under its own id
            if (event.callId && ownCalls.has(event.callId)) break; // an engine may repeat 'running' updates of one call
            ownCalls.add(event.callId);
            toolCalls++;
            const use: ToolUse = { name: event.name, native: true };
            used.push(use);
            nativeUses.set(event.callId, use); // B-059: its tool_end says whether it ran (ok)
            // Engine-native calls carry their human line too (ours get the registry's action summary).
            const target = preview(services.secrets, step.target, 300);
            const args = preview(services.secrets, event.args);
            services.runs.item(request.runId, {
              kind: 'tool_call', name: event.name, effectStatus: 'none',
              data: {
                callId: event.callId, own: true, args,
                ...(args.endsWith('…') ? { argsChars: argsLength(event.args) } : {}), // B-049 F9: the ledger's estimate of a cut preview (an exec script)
                summary: preview(services.secrets, stepText(step), 300), step: { ...step, target },
                ...(event.title ? { title: preview(services.secrets, event.title, 200) } : {}),
                ...(event.nested ? { nested: true, ...(event.parent ? { parent: event.parent } : {}) } : {}), // B-049 F9: a call inside a code-mode script
              },
            });
          } else countOurs(event.callId, shown.name);
          break;
        }
        case 'tool_end':
          watch.call(event.callId, false);
          if (ownCalls.delete(event.callId)) {
            boundary(event.callId, false);
            const native = nativeUses.get(event.callId);
            if (native) native.ok = event.ok; // B-059: a failed or declined engine-native call is no activity (turn-types.ts effectful)
            services.runs.item(request.runId, { kind: 'tool_result', name: native?.name, data: { // B-059 #182: named by its call
              callId: event.callId, ok: event.ok, summary: preview(services.secrets, event.summary, 400),
              ...(event.output ? { output: services.secrets.redact(event.output) } : {}), // B-048 E1 (LEDGER): kept whole by the journal (over 4,000 chars: a blob)
            }, effectStatus: 'none' });
          } else {
            // Our call (MCP hub or dynamic tool); its start may have been missed: a tool still ran.
            const use = countOurs(event.callId);
            if (use && use.ok === undefined) use.ok = event.ok; // callTool's own output decides first
          }
          break;
        case 'usage':
          // Engines report running totals per turn; keep the latest (and the largest context).
          usage.inputTokens = Math.max(usage.inputTokens, event.inputTokens);
          usage.outputTokens = Math.max(usage.outputTokens, event.outputTokens);
          if (event.costUsd !== undefined) usage.costUsd = event.costUsd;
          if (event.contextTokens !== undefined) usage.contextTokens = event.contextTokens;
          break;
        case 'limits':
          services.accounts.updateLimits(turn.account.id, event.limits);
          break;
        case 'status':
          // D5: while an engine-native call runs its worded step is the status; the engine's own raw line
          // for it ("running C:\…\powershell.exe -Command …", "using Read") never replaces it.
          if (ownCalls.size) break;
          status(event.note);
          break;
      }
    } catch (error) {
      services.log.warn('engine event handling failed', { runId: request.runId, type: event.type, error: String(error) });
    }
  };

  const lease = turn.engine.caps.mcp ? services.mcp.lease({
    agent: plan.agent, runId: request.runId, conversationId: plan.conversationId, taskId: plan.task?.id, mode: plan.mode.key, deviceId: plan.agent.deviceId, modelId: turn.route.modelId,
    ...(toolCtx.origin ? { origin: toolCtx.origin } : {}), ...(toolCtx.wakeNote ? { wakeNote: toolCtx.wakeNote } : {}), // B-054: the hub's calls see what started the run too
    ...(toolCtx.split ? { split: toolCtx.split } : {}), // B-057: a split's hub calls carry it too
  }) : undefined;
  // A cut (Stop, emergency stop, urgent interrupt at a boundary) ends the hub's calls and refuses late ones at once.
  const releaseLease = () => lease?.release();
  if (lease) watch.signal.addEventListener('abort', releaseLease, { once: true });
  // The tool offer is computed by buildTurn (SES2: the session's prompt key covers exactly these).
  const tools = turn.engine.caps.dynamicTools ? (turn.tools ?? []) : [];
  const temperature = temperatureOf(plan.previous);
  const cwd = splitCwd(services, plan.split) ?? turnCwd(services, plan.task, plan.agent.id); // I02: the task's own worktree once it has one, else (B-044) the agent's home project, else the workspace; B-057: a split's worktree or its group's folder
  const access = turnAccessPolicy(services, { agentId: plan.agent.id, conversationId: plan.conversationId, runId: request.runId, cwd }); // AF-013: absent = full access as before
  let release: (() => void) | undefined;
  let result: EngineTurnResult;
  try {
    release = await admitAttempt(services, plan, turn, request, status); // CLI engines run processes, HTTP turns are light; B-057 S12: a split holds a Codex slot only to start the app-server (split-admit.ts)
    status('Working'); // D5: the reasoning headline or the running step replaces it as soon as there is one
    watch.start();
    result = await runWithNativeTimeouts(turn.engine, {
      runId: request.runId, agentId: plan.agent.id, account: turn.account, model: turn.model, effort: turn.route.effort,
      ...(temperature !== undefined ? { temperature } : {}), // B-078: the agent's model.set temperature (engines that take one send it)
      session: turn.session ? { ref: turn.session.ref, generation: turn.session.generation } : undefined,
      system: turn.prompt, tools,
      ...(turn.trace && !turn.engine.caps.trace ? { input: [traceInput(turn.trace.calls), ...turn.input] } : { input: turn.input, ...(turn.trace ? { trace: turn.trace } : {}) }),
      callTool: async (name, args, callId) => {
        if (watch.signal.aborted) return failure('The turn was stopped; this call did not run.'); // B-059: never after a cut
        boundary(callId, true);
        watch.call(callId, true); // B-059: before the count – an overrun it triggers waits for this call to end
        try {
          const use = countOurs(callId, calledTool(name, args).name); // B-049 F4: tools.call counts as its target
          const output = await services.tools.call(name, args, toolCtx, callId);
          // Failed or refused: no progress by itself. An unknown external effect may have happened.
          if (use) use.ok = !output.isError || output.effect?.status === 'unknown';
          return output;
        } finally { boundary(callId, false); watch.call(callId, false); }
      },
      mcp: lease ? { url: lease.url, token: lease.token } : undefined,
      cwd, ...(access ? { access } : {}),
      onEvent, signal: watch.signal,
    }, { ...toolCtx, services }, { thread: plan.thread });
  } catch (error) {
    if (request.signal.aborted) result = { text: streamed, stop: 'interrupted' };
    else if (watch.cutError) result = { text: streamed, stop: 'error', error: watch.cutError }; // the stall cut, or B-059's overrun
    else {
      const data = toErrorData(error);
      result = { text: streamed, stop: data.code === 'rate_limited' ? 'limit' : 'error', error: error instanceof WorkforceError ? data : { ...data, code: data.code } };
    }
  } finally {
    thoughts.close(); // a block still open ends with the attempt (live: false)
    watch.stop();
    release?.();
    watch.signal.removeEventListener('abort', releaseLease);
    lease?.release();
  }
  if (turn.trace && (!turn.engine.caps.trace || result.traceAsText)) {
    try { services.runs.item(request.runId, { kind: 'note', data: { traceAsText: result.traceAsText ?? turn.engine.id }, effectStatus: 'none' }); } catch { /* journal is best effort */ }
  }
  result = providerOutage(result, turn.account); // B-059 #184: an engine timeout or a cloud HTTP 500/502/504 is an outage of the account
  // The engine answered the cut as an interrupt (or an error of its own): the stall (B-059: or the overrun) is what happened.
  const cut = watch.cutError;
  if (cut && !request.signal.aborted && result.stop !== 'done') {
    result = { text: streamed, stop: 'error', error: cut, ...(result.session ? { session: result.session } : {}), ...(result.usage ? { usage: result.usage } : {}) };
  }
  if (watch.stalled) {
    services.log.warn('engine stopped responding; attempt cut', { runId: request.runId, engine: turn.engine.id, toolCalls });
    try { services.runs.item(request.runId, { kind: 'note', data: { stalled: { engine: turn.engine.id, afterMs: services.clock.now() - started } }, effectStatus: 'none' }); } catch { /* journal is best effort */ }
  }
  if (result.usage) {
    usage.inputTokens = Math.max(usage.inputTokens, result.usage.inputTokens);
    usage.outputTokens = Math.max(usage.outputTokens, result.usage.outputTokens);
    if (result.usage.costUsd !== undefined) usage.costUsd = result.usage.costUsd;
    Object.assign(usage, addCache(result.usage, {})); // the turn's cached input as its result sums it (Codex's events count per request)
  }
  if (result.contextTokens !== undefined) usage.contextTokens = result.contextTokens;
  return { result, streamed, reasoning: thoughts.text, toolCalls, tools: used, plan: planSteps, ...(planDone !== undefined ? { planDone } : {}), usage, ms: services.clock.now() - started };
}

/** The full length of a call's arguments as the journal would show them uncut (B-049 F9). */
function argsLength(args: unknown): number {
  try { return typeof args === 'string' ? args.length : (JSON.stringify(args) ?? '').length; } catch { return 0; }
}

/**
 * Errors worth one retry on another account/model – an account failure (accounts/failure.ts): before
 * any tool call, or (PR3) after tool calls when every effect is known (`effectsKnown`) – the
 * continuation then gets them as its recap.
 */
export function canFailover(attempt: AttemptResult, signal: AbortSignal, effectsKnown = false): boolean {
  if (signal.aborted || (attempt.toolCalls > 0 && !effectsKnown)) return false;
  return accountFailure(attempt.result) !== undefined;
}
