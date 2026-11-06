// The subconscious's trace on the CLI engines (owner 01.11.2026): real tool pairs in the main AI's history, as if it had made the
// calls itself – Codex thread/inject_items, Claude Code tool_use + tool_result records before the resume. traceItems gives those
// pairs in the rebuild's item form. Only where an engine or version cannot take them (ACP plan CLIs, an injection refused) they go
// as one tool-call-shaped block in the turn input (traceInput).
// Owns: those two forms. Never: runs a call, or changes what a call said.

import { traceCallId, type TraceCall } from '../../shared/model/subconscious.ts';
import type { RebuildItem, TurnInputItem } from './types.ts';

/** The calls as rebuild items: each a real call of ours with its output. */
export function traceItems(calls: readonly TraceCall[], runId: string): RebuildItem[] {
  return calls.map((call, index) => ({
    itemId: `trace${index}`, kind: 't', role: 'tool', text: call.output,
    call: { name: call.tool, args: call.args, callId: traceCallId(runId, index), output: call.output },
  }));
}

/** The fallback: one input item shaped like the calls and their outputs. */
export function traceInput(calls: readonly TraceCall[]): TurnInputItem {
  return { type: 'text', text: calls.map((call) => `<tool_call name="${call.tool}" args='${JSON.stringify(call.args)}'>\n<tool_output>\n${call.output}\n</tool_output>\n</tool_call>`).join('\n') };
}
