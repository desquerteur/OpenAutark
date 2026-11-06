// One ACP prompt turn in a live session: the turn's model and effort (best effort), the prompt
// blocks (instructions or context, text, images, files; B-058 G7: recordings as audio blocks for an agent
// that declares audio), session/update → EngineEvents,
// permission requests answered allow (reject on a readOnly turn), session/cancel on abort and the
// prompt answer → EngineTurnResult; plus the error mapping engine.ts shares (sign-in, limit, gone).
// Owns: the per-turn wiring and its end (interrupted after a 10 s grace when the agent does not
// confirm a cancel).
// Never: starts processes or opens sessions (engine.ts / process.ts).

import * as path from 'node:path';
import { stat } from 'node:fs/promises'; // B-058: a recording's size before it is read
import { pathToFileURL } from 'node:url';
import type { EngineEvent, EngineTurnInput, EngineTurnResult } from '../types.ts';
import type { AcpProcess, LiveSession, SessionTurn } from './process.ts';
import { AcpRpcError, isAuthError, isLimitError } from './protocol.ts';
import { nextConfigRequest } from './config.ts';
import { applyUpdate, hubToolName, hubToolOf, isHubPermission, newTurnState, permissionOutcome, promptUsage, stopFor } from './updates.ts';
import { ERR, isRecord, str } from '../shared.ts';
import { acpDown, providerDownMessage } from '../provider-outage.ts'; // B-059 #184

const CANCEL_GRACE_MS = 10_000;
const SESSION_GONE = /session.*(not found|unknown|does not exist|expired)|unknown session|no such session/i;

export type ReadFile = (file: string) => Promise<Uint8Array>;
type Block = Record<string, unknown>;

/** A failed request as the turn's end: sign-in → unavailable, limit, a lost session → rebase, gone. */
export function failure(error: unknown, name: string, resumed = false): Pick<EngineTurnResult, 'stop' | 'error'> {
  if (isAuthError(error)) return { stop: 'error', error: ERR.unavailable(`${name} is not signed in for this account.`) };
  if (isLimitError(error)) return { stop: 'limit', error: ERR.limit() };
  if (error instanceof AcpRpcError && error.kind === 'closed') return { stop: 'error', error: ERR.unavailable(`${name} stopped unexpectedly.`) };
  if (error instanceof AcpRpcError && error.kind === 'timeout') return { stop: 'error', error: ERR.timeout() };
  if (resumed && error instanceof AcpRpcError && SESSION_GONE.test(error.message)) {
    return { stop: 'error', error: { code: 'conflict', message: `${name} could not continue this session.`, details: { rebase: true } } };
  }
  if (error instanceof AcpRpcError && acpDown(error.message)) return { stop: 'error', error: ERR.unavailable(providerDownMessage(name)) }; // B-059 #184
  return { stop: 'error', error: ERR.failed() };
}

/** An audio block above this goes as a link instead (Gemini CLI reads at most 20 MB per file). */
const AUDIO_BLOCK_MAX = 20 * 1024 * 1024;

/**
 * Prompt content blocks; images only when the agent accepts them (else their path as text). B-058 G7: a
 * recording goes as an ACP audio block `{ type: 'audio', mimeType, data }` when the agent declares the
 * `audio` prompt capability (its text as a block after it); otherwise as before.
 */
export async function promptBlocks(input: EngineTurnInput['input'], images: boolean, context: string | undefined, readFile: ReadFile, audio = false): Promise<Block[]> {
  const out: Block[] = [];
  if (context) out.push({ type: 'text', text: context });
  for (const item of input) {
    if (item.type === 'text') { if (item.text) out.push({ type: 'text', text: item.text }); }
    else if (item.type === 'image') {
      if (!images) { out.push({ type: 'text', text: `[image: ${item.path}]` }); continue; }
      try { out.push({ type: 'image', mimeType: item.mime, data: Buffer.from(await readFile(item.path)).toString('base64') }); }
      catch { out.push({ type: 'text', text: `[image unavailable: ${path.basename(item.path)}]` }); }
    } else if (item.type === 'audio' && audio) {
      const link = { type: 'resource_link', uri: pathToFileURL(item.path).href, name: item.name, mimeType: item.mime };
      // a large recording goes as its link unread (a long video would not fit in memory on a small PC)
      const size = await stat(item.path).then((info) => info.size, () => undefined);
      let bytes: Uint8Array | undefined;
      if (size === undefined || size <= AUDIO_BLOCK_MAX) { try { bytes = await readFile(item.path); } catch { bytes = undefined; } }
      if (size !== undefined && size > AUDIO_BLOCK_MAX) out.push(link);
      else if (!bytes) out.push({ type: 'text', text: `[audio unavailable: ${item.name}]` });
      else if (bytes.byteLength > AUDIO_BLOCK_MAX) out.push(link);
      else out.push({ type: 'audio', mimeType: item.mime, data: Buffer.from(bytes).toString('base64') });
      if (item.text) out.push({ type: 'text', text: item.text });
    } else if (item.text) out.push({ type: 'text', text: `[file: ${item.name} (${item.mime}) at ${item.path}]\n${item.text}` });
    else out.push({ type: 'resource_link', uri: pathToFileURL(item.path).href, name: item.name, mimeType: item.mime });
  }
  if (!out.length) out.push({ type: 'text', text: '(continue)' });
  return out;
}

/** Applies the turn's model and effort when the agent offers them (a refusal leaves its current choice). */
async function applyConfig(proc: AcpProcess, session: LiveSession, input: EngineTurnInput, emit: (event: EngineEvent) => void): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const next = nextConfigRequest(session.id, session.config, input.model, input.effort);
    if (!next) return;
    try { next.apply(await proc.conn.request(next.method, next.params, 20_000)); }
    catch { emit({ type: 'status', note: 'model choice not applied' }); return; }
  }
}

/** A Gemini-style tool call id ("tasks__create-1760000000000") as a display name hint. */
function nameFromId(id: string): string | undefined {
  const wire = /^([A-Za-z0-9_-]{1,64}?)-\d+$/.exec(id)?.[1];
  return wire ? hubToolName(wire) : undefined;
}

export async function runAcpTurn(args: {
  proc: AcpProcess; session: LiveSession; input: EngineTurnInput; context?: string; readFile: ReadFile; resumed: boolean; cancelGraceMs?: number;
}): Promise<EngineTurnResult> {
  const { proc, session, input } = args;
  const name = proc.launch.name;
  const emit = (event: EngineEvent) => { try { input.onEvent(event); } catch { /* UI listener errors never break a turn */ } };
  const state = newTurnState();
  let grace: ReturnType<typeof setTimeout> | undefined;
  let giveUp!: () => void;
  const unconfirmed = new Promise<'unconfirmed'>((resolve) => { giveUp = () => resolve('unconfirmed'); });

  const turn: SessionTurn = {
    update: (update) => applyUpdate(state, update, emit),
    permission: async (params) => {
      const options = Array.isArray(params.options) ? params.options : [];
      const call = isRecord(params.toolCall) ? params.toolCall : {};
      if (input.signal.aborted) return permissionOutcome(options, 'cancel');
      if (isHubPermission(call, options)) {
        const id = str(call.toolCallId);
        if (id) state.hubCalls.set(id, hubToolOf(call) ?? nameFromId(id) ?? 'workforce');
        return permissionOutcome(options, 'allow');
      }
      return permissionOutcome(options, input.readOnly ? 'deny' : 'allow');
    },
  };
  const onAbort = () => {
    proc.conn.notify('session/cancel', { sessionId: session.id });
    grace = setTimeout(giveUp, args.cancelGraceMs ?? CANCEL_GRACE_MS);
    grace.unref?.();
  };
  const detach = proc.attachTurn(session, turn);
  const endTurn = proc.beginTurn();
  input.signal.addEventListener('abort', onAbort, { once: true });
  try {
    await applyConfig(proc, session, input, emit);
    const prompt = await promptBlocks(input.input, proc.info.images, args.context, args.readFile, proc.info.audio);
    const base = (): EngineTurnResult => {
      const result: EngineTurnResult = { text: state.text.trim(), stop: 'done', session: { ref: session.id, generation: input.session?.generation ?? 1 } };
      if (state.contextTokens !== undefined) result.contextTokens = state.contextTokens;
      if (state.contextWindow !== undefined) result.contextWindow = state.contextWindow;
      if (state.files.length) result.files = state.files;
      return result;
    };
    if (input.signal.aborted) return { ...base(), stop: 'interrupted', error: ERR.cancelled() };
    let answer: unknown;
    try {
      answer = await Promise.race([proc.conn.request('session/prompt', { sessionId: session.id, prompt }, 0), unconfirmed]);
    } catch (error) {
      if (input.signal.aborted) return { ...base(), stop: 'interrupted', error: ERR.cancelled() };
      return { ...base(), ...failure(error, name, args.resumed) };
    }
    const result = base();
    const usage = promptUsage(answer);
    if (usage) {
      result.usage = usage;
      emit({ type: 'usage', ...usage, ...(state.contextTokens !== undefined ? { contextTokens: state.contextTokens } : {}) });
    }
    if (answer === 'unconfirmed' || input.signal.aborted) return { ...result, stop: 'interrupted', error: ERR.cancelled() };
    const end = stopFor(isRecord(answer) ? answer.stopReason : undefined);
    return { ...result, ...end };
  } finally {
    input.signal.removeEventListener('abort', onAbort);
    if (grace) clearTimeout(grace);
    detach();
    endTurn();
  }
}
