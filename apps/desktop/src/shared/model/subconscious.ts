// What the main AI sees of the subconscious (owner 01.11.2026): only real tool calls with their output, as if it had made
// them itself – e.g. vector.search {query, in} with the hits the subconscious picked, its own tool (the one the main AI can call) with a note. An empty
// trace shows nothing at all and the main AI's next model turn simply follows; there is no hint text in any prompt.
// Owns: the trace shape, its size cap and the ids of its calls. Never: runs anything or knows an engine's wire format.

/** The name a note of the subconscious stands under in the main AI's history: the tool it has in its list. */
export const NOTE_CALL = 'subconscious';

/** One call the subconscious made that matters for the agent. */
export interface TraceCall {
  tool: string;
  args: Record<string, unknown>;
  output: string;
  /** When a kept call was kept (absent until then): an old note or hit is not shown any more. */
  at?: number;
}

/** The calls shown to the main AI before its turn's model call (empty = nothing to show). */
export interface SubconsciousTrace {
  calls: TraceCall[];
}

/** The most a trace may cost the main AI's context, in tokens (a token ≈ 4 characters). */
export const TRACE_TOKENS = 600;
const CHARS_PER_TOKEN = 4;
/** Below this many characters left a call is dropped rather than cut to nothing. */
const MIN_OUTPUT_CHARS = 80;
const CUT = ' … [cut]';

/** True when the trace has something to show. */
export function hasTrace(trace: SubconsciousTrace | undefined): trace is SubconsciousTrace {
  return Boolean(trace?.calls.length);
}

/** The trace within `maxTokens`: earlier calls first, the call that does not fit cut (and saying so), later ones dropped. */
export function capTrace(trace: SubconsciousTrace, maxTokens = TRACE_TOKENS): SubconsciousTrace {
  let left = maxTokens * CHARS_PER_TOKEN;
  const calls: TraceCall[] = [];
  for (const call of trace.calls) {
    left -= call.tool.length + JSON.stringify(call.args).length;
    if (left < MIN_OUTPUT_CHARS) break;
    const output = call.output.trim();
    calls.push({ ...call, output: output.length > left ? `${output.slice(0, left - CUT.length).trimEnd()}${CUT}` : output });
    left -= output.length;
  }
  return { calls };
}

/** What every call id of a trace starts with (the ledger finds the subconscious's calls by it). */
export const TRACE_CALL_PREFIX = 'sc_';

/** A stable id for the n-th call of a trace in a run: letters, digits, '_' and '-' only, valid on every provider API. */
export function traceCallId(runId: string, index: number): string {
  const base = runId.replace(/[^A-Za-z0-9_-]/g, '').slice(-24) || 'turn';
  return `${TRACE_CALL_PREFIX}${base}_${index}`;
}
