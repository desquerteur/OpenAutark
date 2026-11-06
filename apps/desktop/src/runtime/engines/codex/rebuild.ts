// Codex native rebuild (B-048 E2, tier 1): the context ledger's view becomes the model-visible history of a
// fresh thread (started by engine.ts with the turn's instructions, config and dynamic tools).
// Owns: the translation RebuildItem[] → raw Responses items – user/assistant messages; our hub tools as
// function_call + function_call_output with a paired call_id and the dynamic tool's wire name; engine-native
// tools through neutral-calls.ts (B-049: a shell call of Claude or Codex as Codex's own exec_command
// function_call + output, Claude's Read/Grep/Glob as our files.read/files.search when the thread has them, an
// edit as a note with its diff or content); every other native tool as an assistant note
// "[ran <tool>: <summary>]" plus its output as a user-side note; reasoning as a reasoning item only with
// encrypted content of the same account and model family, else not at all (as assistant text it reads as words the model never said); a
// condensed item's restore stamp stays in its text –, the injection in chunks (thread/inject_items), the
// check with thread/items/list where this Codex lists injected items before a turn (the probe says so per
// version), and the model-free probe (thread/start, inject a message and a call/output pair, items/list,
// thread/delete – no turn). B-075: a thread opened here waits THREAD_OPEN_MS and is stored hidden from the Codex desktop
// app's lists, like every new agent thread (helper-thread.ts HIDDEN_THREAD).
// Live (28.10., codex-cli 0.165.0-alpha.1.2, temp CODEX_HOME, no login): thread/start with dynamicTools,
// inject_items of user/assistant messages and a function_call/function_call_output pair answered {};
// thread/items/list listed 0 items before a turn (verify 'accepted'); thread/delete answered {}.
// B-049 F7 (revertThread): a garden rebuild may keep the thread instead – thread/revert before a recorded turn, then
// the tail injected. Live 28.10. (codex-cli 0.164.0-alpha.11.1): agent threads open with historyMode 'paginated'
// (non-ephemeral) and thread/revert answers on them; the turn after revert + inject had 15,488 of 15,705 input
// tokens cached, a fresh thread holding the same items 0.
// B-049 F9 (code mode): an exec call replays as Codex's own custom_tool_call + custom_tool_call_output (a wait call as its
// function_call pair) when this version's probe saw such items injected (`custom`; live 29.10., codex-cli 0.165: accepted,
// output as text or as content items) – else as a note with the script; a call made inside a script (nested) is never
// replayed. The probe injects an exec pair after its first items and reports `custom`.
// injectTrace: the subconscious's calls of a turn as function_call + function_call_output pairs on the open thread (owner
// 01.11.2026; a refusal returns its reason and the turn takes them as text).
// Never: starts a turn, injects a call that did not run (every function_call is a real earlier call with its real,
// bounded output; the trace's pairs are the calls the subconscious made), or keeps a new thread whose rebuild failed (thread/delete).

import type { RebuildItem, RebuildProbe } from '../types.ts';
import type { TraceCall } from '../../../shared/model/subconscious.ts';
import { traceItems } from '../trace-text.ts';
import type { RpcClient } from './rpc.ts';
import { RpcError } from './rpc.ts';
import { HIDDEN_THREAD, THREAD_OPEN_MS } from './helper-thread.ts';
import { isRecord, str, toWireName } from '../shared.ts';
import { boundOutput, noteText, oursCall, outputNote, sameReasoningSource, withStamp } from '../rebuild-text.ts';
import { CODEX_NATIVE, mapNativeCall, type Mapped } from '../neutral-calls.ts';

/** Items per thread/inject_items call, and characters per call (Codex sets no limit; requests stay moderate). */
export const CHUNK_ITEMS = 40;
export const CHUNK_CHARS = 200_000;
/** thread/items/list pages read for the check (200 items each). */
const LIST_PAGES = 25;

type ResponseItem = Record<string, unknown>;

const message = (role: 'user' | 'assistant', text: string): ResponseItem =>
  ({ type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });

/** Codex's function_call arguments: a JSON string (a string argument is kept as it is). */
function argumentsText(args: unknown): string {
  if (typeof args === 'string') return args;
  try { return JSON.stringify(args ?? {}); } catch { return '{}'; }
}

/**
 * The Responses items for a ledger view on Codex (`offered`: the thread's dynamic tools; `platform`: where the
 * app-server runs – a shell call names its shell when it is not that platform's default; `custom`: the probe saw
 * custom_tool_call items injected – exec replays natively). A nested item (a call inside a script) is skipped.
 */
export function responseItems(items: RebuildItem[], target: { offered: ReadonlySet<string>; accountId: string; model: string; platform?: string; custom?: boolean }): ResponseItem[] {
  const out: ResponseItem[] = [];
  const callIds = new Set<string>();
  const mapTarget = { engine: 'codex' as const, offered: target.offered, native: CODEX_NATIVE, platform: target.platform ?? process.platform, custom: target.custom === true };
  for (const item of items) {
    if (item.nested) continue; // B-049 F9: the model never saw it – its script's call and output stand for it
    const call = item.call;
    if (call) {
      const mapped: Mapped | undefined = oursCall(call) ? undefined : mapNativeCall(call, item.origin?.engine, mapTarget);
      if (mapped?.as === 'note') {
        out.push(message('assistant', noteText(call, mapped.detail, item.calls)));
        out.push(message('user', outputNote(call, item.stamp)));
        continue;
      }
      let callId = call.callId?.trim() || `call_${item.itemId}`;
      if (callIds.has(callId)) callId = `${callId}_${item.itemId}`;
      callIds.add(callId);
      if (mapped?.as === 'custom') { // B-049 F9: code mode's exec, as Codex holds it
        out.push({ type: 'custom_tool_call', name: mapped.name, input: mapped.input, call_id: callId });
        out.push({ type: 'custom_tool_call_output', call_id: callId, output: withStamp(boundOutput(call.output || (call.ok === false ? 'failed' : 'ok')), item.stamp) });
        continue;
      }
      const name = !mapped ? toWireName(call.name) : mapped.as === 'hub' ? toWireName(mapped.name) : mapped.name;
      out.push({ type: 'function_call', name, arguments: argumentsText(mapped ? mapped.args : call.args), call_id: callId });
      out.push({ type: 'function_call_output', call_id: callId, output: withStamp(boundOutput(call.output || (call.ok === false ? 'failed' : 'ok')), item.stamp) });
      continue;
    }
    if (item.kind === 'r') {
      const encrypted = item.reasoning?.encrypted;
      if (encrypted && sameReasoningSource(item, { engine: 'codex', accountId: target.accountId, model: target.model })) {
        out.push({ type: 'reasoning', summary: item.text.trim() ? [{ type: 'summary_text', text: item.text }] : [], encrypted_content: encrypted });
      }
      continue;
    }
    const text = withStamp(item.text, item.stamp);
    if (!text.trim()) continue;
    out.push(message(item.role === 'assistant' ? 'assistant' : 'user', item.role === 'tool' ? `[${item.itemId}]\n${boundOutput(text)}` : text));
  }
  return out;
}

/** Splits items into inject_items calls of at most `maxItems` items and about `maxChars` characters. */
export function chunks<T>(list: T[], maxItems = CHUNK_ITEMS, maxChars = CHUNK_CHARS): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const entry of list) {
    const size = JSON.stringify(entry).length;
    if (current.length && (current.length >= maxItems || chars + size > maxChars)) { out.push(current); current = []; chars = 0; }
    current.push(entry);
    chars += size;
  }
  if (current.length) out.push(current);
  return out;
}

/** How many items thread/items/list shows for a thread; undefined when this Codex cannot list them. */
export async function listedCount(rpc: RpcClient, threadId: string): Promise<number | undefined> {
  let count = 0;
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGES; page++) {
    let result: unknown;
    try { result = await rpc.request('thread/items/list', { threadId, limit: 200, ...(cursor ? { cursor } : {}) }, 30_000); } catch { return undefined; }
    const data = isRecord(result) && Array.isArray(result.data) ? result.data : undefined;
    if (!data) return undefined;
    count += data.length;
    cursor = isRecord(result) ? str(result.nextCursor) : undefined;
    if (!cursor) break;
  }
  return count;
}

/**
 * Injects `items` into `threadId` in chunks; with verify 'count' checks that thread/items/list shows at least
 * every injected message (a call and its output may show as one item). Throws on a refusal or a mismatch.
 */
export async function injectHistory(rpc: RpcClient, threadId: string, items: ResponseItem[], verify: RebuildProbe['verify']): Promise<void> {
  for (const [index, chunk] of chunks(items).entries()) {
    try { await rpc.request('thread/inject_items', { threadId, items: chunk }, 60_000); } catch (error) {
      throw new Error(`thread/inject_items refused chunk ${index + 1}: ${error instanceof Error ? error.message.slice(0, 200) : 'failed'}`);
    }
  }
  if (verify !== 'count') return;
  const expected = items.filter((item) => item.type === 'message').length;
  const listed = await listedCount(rpc, threadId);
  if (listed === undefined || listed < expected) throw new Error(`item mismatch: ${listed ?? 'no'} listed, at least ${expected} expected`);
}

/**
 * A new thread (`start`: the turn's settings and dynamic tools) holding `items`; deleted again when the injection fails. Its id.
 * `open` starts the thread (B-049 F1: the engine's lean agent thread with its fallback; default a plain thread/start).
 */
export async function startRebuiltThread(
  rpc: RpcClient, start: Record<string, unknown>, items: ResponseItem[], verify: RebuildProbe['verify'],
  open: (params: Record<string, unknown>) => Promise<{ thread?: { id?: string } }> = (params) => rpc.request('thread/start', { ...params, ...HIDDEN_THREAD }, THREAD_OPEN_MS),
): Promise<string> {
  const started = await open(start);
  const threadId = str(started?.thread?.id);
  if (!threadId) throw new Error('Codex did not start a session.');
  try { await injectHistory(rpc, threadId, items, verify); } catch (error) {
    await rpc.request('thread/delete', { threadId }, 30_000).catch(() => undefined);
    throw error;
  }
  return threadId;
}

/**
 * B-049 F7: cuts `threadId`'s history before `beforeTurnId` (thread/revert – the thread, its prompt cache key and the
 * prefix stay) and injects `items`, the tail. A refused revert throws with the thread unchanged; a failed injection
 * throws `cut: true` – the thread lost its tail and must not continue as it is.
 */
export async function revertThread(rpc: RpcClient, threadId: string, beforeTurnId: string, items: ResponseItem[], verify: RebuildProbe['verify']): Promise<void> {
  try { await rpc.request('thread/revert', { threadId, beforeTurnId }, 60_000); } catch (error) {
    throw new Error(`thread/revert refused: ${error instanceof Error ? error.message.slice(0, 200) : 'failed'}`);
  }
  try { await injectHistory(rpc, threadId, items, verify); } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error('inject failed'), { cut: true });
  }
}

/** The subconscious's calls injected into `threadId` as real pairs; undefined when done, else why Codex refused them. */
export async function injectTrace(rpc: RpcClient, threadId: string, calls: readonly TraceCall[], runId: string): Promise<string | undefined> {
  const items = responseItems(traceItems(calls, runId), { offered: new Set(), accountId: '', model: '' });
  try {
    await rpc.request('thread/inject_items', { threadId, items }, 30_000);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 200) : 'refused';
  }
}

const PROBE_TOOL = { type: 'function', name: 'workforce_probe', description: 'Probe tool of the app (never called).', inputSchema: { type: 'object', properties: {} } };
const PROBE_ITEMS: ResponseItem[] = [
  message('user', 'Probe of the app: an earlier request.'),
  { type: 'function_call', name: 'workforce_probe', arguments: '{}', call_id: 'call_workforce_probe' },
  { type: 'function_call_output', call_id: 'call_workforce_probe', output: 'ok' },
  message('assistant', 'Probe of the app: an earlier answer.'),
];
/** B-049 F9: code mode's exec as Codex holds it – a refusal only turns native exec replay off. */
const PROBE_CUSTOM: ResponseItem[] = [
  { type: 'custom_tool_call', name: 'exec', input: 'text("probe of the app")', call_id: 'call_workforce_probe_exec' },
  { type: 'custom_tool_call_output', call_id: 'call_workforce_probe_exec', output: 'Script completed\nOutput:\nprobe of the app' },
];

/**
 * The model-free probe on a running app-server: a thread like an agent's (`settings` – instructions,
 * isolation – plus one probe tool), a message and a call/output pair injected, items listed, an exec pair injected
 * (B-049 F9: `custom`), the thread deleted.
 */
export async function probeCodexRebuild(rpc: RpcClient, settings: Record<string, unknown>, version: string, now: number): Promise<RebuildProbe> {
  let threadId: string | undefined;
  try {
    const started = await rpc.request<{ thread?: { id?: string } }>('thread/start', { ...settings, dynamicTools: [PROBE_TOOL], ...HIDDEN_THREAD }, THREAD_OPEN_MS);
    threadId = str(started?.thread?.id);
    if (!threadId) return { version, ok: false, reason: 'thread/start gave no thread', at: now };
    await rpc.request('thread/inject_items', { threadId, items: PROBE_ITEMS }, 30_000);
    const listed = await listedCount(rpc, threadId);
    const custom = await rpc.request('thread/inject_items', { threadId, items: PROBE_CUSTOM }, 30_000).then(() => true, () => false);
    return { version, ok: true, verify: listed !== undefined && listed > 0 ? 'count' : 'accepted', custom, at: now };
  } catch (error) {
    const reason = error instanceof RpcError ? `${error.rpcCode}: ${error.message.slice(0, 160)}` : error instanceof Error ? error.message.slice(0, 160) : 'failed';
    return { version, ok: false, reason, at: now };
  } finally {
    if (threadId) await rpc.request('thread/delete', { threadId }, 30_000).catch(() => undefined);
  }
}
