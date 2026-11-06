// The tool call journal for tools/registry.ts: the run items of a call and of its result, written
// best effort, and the idempotency lookups a resent call is answered from.
// Owns: those writes and reads, the arguments as the journal shows them (hidden keys replaced) and
// the compact result (text parts – the row keeps at most 4000 characters, a longer text is kept whole in a blob by
// runs/journal.ts, B-048 E1 –, a redacted 600-character preview).
// Never: fails a call because the journal could not be written, or stores a hidden argument's value.

import type { RuntimeServices } from '../contracts.ts';
import { toErrorData } from '../../shared/errors.ts';
import type { ToolOutput } from './types.ts';
import { outputText, preview } from './outputs.ts';

type RunItem = Parameters<RuntimeServices['runs']['item']>[1];
type RunItemPatch = Parameters<RuntimeServices['runs']['updateItem']>[1];

/** Journals a run item; its id, or undefined when the journal could not take it (logged). */
export function safeItem(services: RuntimeServices, runId: string, item: RunItem): string | undefined {
  try { return services.runs.item(runId, item).id; } catch (error) {
    services.log.warn('run item not journaled', { runId, name: item.name, error: toErrorData(error).message });
    return undefined;
  }
}

export function safeUpdate(services: RuntimeServices, id: string, patch: RunItemPatch): void {
  try { services.runs.updateItem(id, patch); } catch { /* journal is best effort; the effect state is logged */ }
}

/** The call's arguments as the journal shows them: `hidden` keys (registry HIDDEN_ARGS) read '[hidden]'. */
export function journalArgs(input: Record<string, unknown>, hidden: readonly string[] | undefined): Record<string, unknown> {
  return hidden ? Object.fromEntries(Object.entries(input).map(([key, value]) => [key, hidden.includes(key) ? '[hidden]' : value])) : input;
}

/** Was a call with this idempotency key journaled before (by another invocation)? */
export function journaled(services: RuntimeServices, idemKey: string): boolean {
  try { return services.db.get('SELECT 1 AS hit FROM run_items WHERE idem_key = ?', [idemKey]) !== undefined; } catch { return false; }
}

/** The journaled output under `key` (a call's '<idemKey>:result'), if any. */
export function cachedResult(services: RuntimeServices, key: string): ToolOutput | undefined {
  try {
    const row = services.db.get<{ data: string }>('SELECT data FROM run_items WHERE idem_key = ?', [key]);
    if (!row) return undefined;
    const data = JSON.parse(row.data) as { output?: ToolOutput };
    return data.output;
  } catch {
    return undefined;
  }
}

/** Journals a call's result under '<idemKey>:result'. B-048 E1: a text
 *  over 4000 characters goes to the journal whole, as one part – the row keeps 4000 of it, the journal keeps all of it in a
 *  blob for the context ledger (runs/journal.ts). */
export function journalResult(services: RuntimeServices, runId: string, name: string, callId: string, idemKey: string, output: ToolOutput, blobIds: string[]): void {
  const textValue = outputText(output);
  const compactOutput: ToolOutput = textValue.length > 4000
    ? { content: [{ type: 'text', text: textValue }], isError: output.isError, effect: output.effect }
    : { content: output.content.filter((part) => part.type === 'text'), isError: output.isError, effect: output.effect };
  safeItem(services, runId, {
    kind: 'tool_result', name,
    data: { callId, ok: !output.isError, preview: preview(services.secrets, textValue, 600), blobIds, output: compactOutput },
    effectStatus: 'none', idemKey: `${idemKey}:result`,
  });
}
