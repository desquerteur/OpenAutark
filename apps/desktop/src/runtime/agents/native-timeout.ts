// Native tool deadlines of one engine attempt: status events never extend a call. The subconscious
// can wait again or interrupt the native turn. Interrupted, the same session receives its decision and the actual result as a
// real tool call and its output on a continuation, without replaying the original request; its words say that the app's time
// limit stopped the call and nobody declined it (B-072). Not interrupted, the decisions reach
// it at once where the engine can (engine.tell), else before its next turn: a turn that ended well is not started again. Nested
// calls suspend their script's timer.
// Owns: deadlines, decision delivery and native continuation. Never: guesses a command's result.

import type { CacheTokens, Engine, EngineEvent, EngineTurnInput, EngineTurnResult } from '../engines/types.ts';
import { addCache } from '../engines/shared.ts';
import type { ToolContext } from '../tools/types.ts';
import { NOTE_CALL, type TraceCall } from '../../shared/model/subconscious.ts';
import { APP_STOPPED, initialTimeoutSeconds, reviewToolTimeout, timeoutDecisionText } from '../tools/timeout.ts';

interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface NativeTimeoutOptions {
  /** The turn's thread: where decisions wait that could not reach a turn that ended well. */
  thread?: string;
  now?: () => number;
  timers?: Timers;
  initial?: typeof initialTimeoutSeconds;
  review?: typeof reviewToolTimeout;
  deliveryMs?: number;
}

interface Call {
  id: string;
  tool: string;
  native: boolean;
  args: unknown;
  started: number;
  seconds: number;
  handle?: unknown;
  review?: AbortController;
  notes: string[];
  reviews: number;
  parent?: string;
  children: Set<string>;
}

const NODE_TIMERS: Timers = {
  set: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const NO_OUTPUT = 'The native turn was interrupted. No final tool output was received; its side effects may already have occurred.';
/** The continuation's words (B-072: an engine may call the interrupt the user's rejection – it is the app's time limit). */
const CONTINUE = `${APP_STOPPED} I continue from these tool results, check any unknown effects and go on – other ways work too.`;
const MAX_NOTES = 20;
/** What the main AI sees the decisions as: the subconscious's call, never words in its input (live 02.11.2026: a steered user message). */
const toCall = (text: string): TraceCall => ({ tool: NOTE_CALL, args: {}, output: text });
/** The main AI has read the tool's output by then. */
const OUTPUT_HEAD = '\nTool output:';
const withoutOutput = (text: string) => text.split(OUTPUT_HEAD)[0];

/** A native interruption resumes only its existing session; a caller's stop always wins. */
export async function runWithNativeTimeouts(engine: Engine, input: EngineTurnInput, ctx: ToolContext, options: NativeTimeoutOptions = {}): Promise<EngineTurnResult> {
  const now = options.now ?? Date.now;
  const timers = options.timers ?? NODE_TIMERS;
  const initial = options.initial ?? initialTimeoutSeconds;
  const review = options.review ?? reviewToolTimeout;
  const totals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let cache: CacheTokens = {};
  let hadUsage = false;
  let hadCost = false;
  let next = input;
  let compacted = false;
  let traceAsText: string | undefined;
  const files: NonNullable<EngineTurnResult['files']> = [];
  for (;;) {
    const cut = new AbortController();
    const signal = AbortSignal.any([input.signal, cut.signal]);
    const calls = new Map<string, Call>();
    const undelivered: string[] = [];
    const deliveries: Promise<void>[] = [];
    let interrupted = false;
    let ended = false;
    const clear = (call: Call) => {
      if (call.handle !== undefined) timers.clear(call.handle);
      call.handle = undefined;
      call.review?.abort();
      call.review = undefined;
    };
    const note = (call: Call, output: string) => [
      `Native tool ${call.tool} (${call.id})`,
      'Subconscious timeout decisions:',
      ...(call.reviews > call.notes.length ? [`${call.reviews - call.notes.length} earlier decisions are recorded in the run journal.`] : []), ...call.notes,
      `${OUTPUT_HEAD.trimStart()}\n${ctx.services.secrets.redact(output).slice(0, 12_000)}`,
    ].join('\n');
    const deliver = (text: string) => {
      if (cut.signal.aborted || input.signal.aborted || !engine.tell) { undelivered.push(text); return; }
      deliveries.push(new Promise<void>((resolve) => {
        let settled = false;
        const finish = (delivered: boolean) => {
          if (settled) return;
          settled = true;
          timers.clear(timer);
          signal.removeEventListener('abort', cancel);
          if (!delivered) undelivered.push(text);
          resolve();
        };
        const cancel = () => finish(false);
        const timer = timers.set(cancel, options.deliveryMs ?? 10_000);
        signal.addEventListener('abort', cancel, { once: true });
        try { void engine.tell!(input.runId, toCall(text)).then(finish, cancel); } catch { cancel(); }
      }));
    };
    const arm = (call: Call, seconds: number) => {
      if (ended || signal.aborted || !call.native || call.children.size) return;
      call.seconds = seconds;
      call.handle = timers.set(() => {
        call.handle = undefined;
        void inspect(call);
      }, seconds * 1000);
    };
    const inspect = async (call: Call) => {
      if (ended || signal.aborted || calls.get(call.id) !== call || call.children.size) return;
      const checking = new AbortController();
      call.review = checking;
      const timeout = { tool: call.tool, args: call.args, elapsedSeconds: Math.max(1, Math.round((now() - call.started) / 1000)), timeoutSeconds: call.seconds, output: 'No tool output has been reported yet; this native tool is still running.' };
      const decision = await review({ ...ctx, signal, callId: call.id }, timeout, AbortSignal.any([signal, checking.signal]));
      if (ended || signal.aborted || checking.signal.aborted || calls.get(call.id) !== call) return;
      call.review = undefined;
      const text = timeoutDecisionText(timeout, decision);
      call.notes.push(text);
      call.reviews++;
      if (call.notes.length > MAX_NOTES) call.notes.shift();
      input.onEvent({ type: 'status', note: text.slice(0, 140) });
      if (decision.action === 'wait' && decision.seconds !== undefined) arm(call, decision.seconds);
      else { interrupted = true; cut.abort(); }
    };
    const event = (value: EngineEvent) => {
      if (value.type === 'tool_start' && (value.own || (value.parent && calls.has(value.parent))) && value.callId && !calls.has(value.callId)) {
        const call: Call = { id: value.callId, tool: value.name, native: value.own, args: value.args, started: now(), seconds: value.own ? initial(value.name, value.args) : 0, notes: [], reviews: 0, children: new Set(), ...(value.parent ? { parent: value.parent } : {}) };
        calls.set(call.id, call);
        const parent = call.parent ? calls.get(call.parent) : undefined;
        if (parent) { clear(parent); parent.children.add(call.id); }
        arm(call, call.seconds);
      } else if (value.type === 'tool_end') {
        const call = calls.get(value.callId);
        if (call) {
          clear(call);
          calls.delete(call.id);
          if (call.notes.length) deliver(note(call, value.output ?? value.summary));
          const parent = call.parent ? calls.get(call.parent) : undefined;
          if (parent) { parent.children.delete(call.id); if (!parent.children.size) arm(parent, parent.seconds); }
        }
      }
      input.onEvent(value);
    };
    let result: EngineTurnResult;
    try { result = await engine.run({ ...next, onEvent: event, signal }); }
    finally {
      ended = true;
      for (const call of calls.values()) clear(call);
    }
    await Promise.all(deliveries);
    compacted ||= result.compacted === true;
    traceAsText ??= result.traceAsText;
    files.push(...result.files ?? []);
    if (result.usage) {
      hadUsage = true;
      totals.inputTokens += result.usage.inputTokens;
      totals.outputTokens += result.usage.outputTokens;
      cache = addCache(cache, result.usage);
      if (result.usage.costUsd !== undefined) { hadCost = true; totals.costUsd += result.usage.costUsd; }
    }
    for (const call of calls.values()) {
      if (call.notes.length) undelivered.push(note(call, NO_OUTPUT));
      if (interrupted && call.native) input.onEvent({ type: 'tool_end', callId: call.id, ok: false, summary: NO_OUTPUT });
    }
    const final = (): EngineTurnResult => ({
      ...result,
      ...(hadUsage ? { usage: { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, ...cache, ...(hadCost ? { costUsd: totals.costUsd } : {}) } } : {}),
      ...(compacted ? { compacted: true } : {}), ...(traceAsText ? { traceAsText } : {}), ...(files.length ? { files } : {}),
    });
    if (input.signal.aborted || !interrupted || !result.session) {
      if (undelivered.length && !input.signal.aborted && options.thread !== undefined) ctx.services.subconscious?.putBack?.(input.agentId, options.thread, { calls: undelivered.map(withoutOutput).map(toCall) });
      return final();
    }
    next = {
      ...input, session: result.session, trace: { calls: undelivered.map(toCall) },
      input: [{ type: 'text', text: CONTINUE }],
    };
  }
}
