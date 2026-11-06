// Base for stateless HTTP engines (openai, anthropic, compatible).
// Owns: API key lookup (in-process only), model listing via GET /models (12 s, ≤500 ids, ids that
// contain the key are dropped), account checks, image loading, the per-turn tool loop driver and
// the turn's usage: tokens (and the cached parts a request reports) summed over its requests, and a provider-reported cost (PR9:
// OpenRouter) only when every request of the turn reported one – a partial sum would undercount,
// so models/pricing.ts prices the tokens instead.
// MM10: audio parts. splitInput turns them into a note unless the adapter hears them (only
// compatible.ts asks for them); `audio()` loads one WAV/MP3 of at most AUDIO_INPUT_BYTES.
// Steering (21.10. 17:09): steer() queues text for a running turn; the loop adds it as a user
// message before its next request – after the tool results of the current round, never inside a
// tool call – and an answer that ended while text waited gets one more request to take it in. Not
// after a provider pause (pause_turn is resumed unchanged). A call of the round that has not started
// when text waits is not run (NOT_RUN_STEERED as its result): the model decides it again with the
// message – a call in flight always finishes.
// The subconscious's trace (input.trace): each adapter's injectTrace appends real tool-call + tool-result messages before the
// first request – the whole projection is one user message, so the calls follow it and the model's next turn follows them.
// Never: stores keys, puts them in events/errors, or retries a tool call.

import { promises as fsp } from 'node:fs';
import type { Account, EngineId } from '../../../shared/model/providers.ts';
import type { AccountCheck, CacheTokens, Engine, EngineCaps, EngineEvent, EngineModel, EngineTurnInput, EngineTurnResult } from '../types.ts';
import type { ToolOutput } from '../../tools/types.ts';
import { hasTrace, type TraceCall } from '../../../shared/model/subconscious.ts';
import { ToolNames, addCache, safeCall, outputText } from '../shared.ts';
import { HttpEngineError, LOCAL_PROVIDERS, MAX_TOOL_ITERATIONS, endpointFor, readJson, redact, statusError, turnError, type FetchFn } from './common.ts';

/** A call the model chose before a steered message arrived is not started; the model re-checks it with the message. */
export const NOT_RUN_STEERED = 'Not run: a new message from the person arrived. Read it and decide again before doing this.';

/** MM10: the most audio one input_audio part carries (base64 makes the request about a third larger). */
export const AUDIO_INPUT_BYTES = 10 * 1024 * 1024;

export type AudioFormat = 'wav' | 'mp3';

const AUDIO_FORMATS: Record<string, AudioFormat> = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mpeg3': 'mp3', 'audio/x-mpeg-3': 'mp3',
};

/** The input_audio format of a file (its type first; the name only for an untyped file), else undefined. */
export function audioFormat(mime: string, name = ''): AudioFormat | undefined {
  const type = mime.split(';')[0].trim().toLowerCase();
  if (AUDIO_FORMATS[type]) return AUDIO_FORMATS[type];
  if (type && type !== 'application/octet-stream') return undefined;
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return extension === 'wav' || extension === 'mp3' ? extension : undefined;
}

export interface HttpEngineDeps {
  fetch?: FetchFn;
  /** Decrypted key for an account (AccountService.apiKey). */
  apiKey: (account: Account) => Promise<string | undefined>;
  readFile?: (path: string) => Promise<Uint8Array>;
}

export interface LoopStep {
  text: string; // text of this request
  calls: Array<{ id: string; name: string; args: unknown }>; // wire names
  usage?: StepUsage;
  done: boolean; // no tool calls → final
  continue?: boolean; // provider paused the turn: send again without new input
  structured?: unknown;
}

/** Tokens of one request (the cached part of the input beside them, when reported); `costUsd` = the provider's own price of it (PR9), when it reports one. */
export interface StepUsage extends CacheTokens { inputTokens: number; outputTokens: number; costUsd?: number }

/** Sums the requests of one turn; the cost only while every request reported one. */
class TurnUsage {
  private inputTokens = 0;
  private outputTokens = 0;
  private cache: CacheTokens = {};
  private cost = 0;
  private requests = 0;
  private priced = 0;

  add(usage: StepUsage | undefined): void {
    this.requests++;
    if (!usage) return;
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.cache = addCache(this.cache, usage);
    if (typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) { this.cost += usage.costUsd; this.priced++; }
  }

  result(): StepUsage {
    const out: StepUsage = { inputTokens: this.inputTokens, outputTokens: this.outputTokens, ...this.cache };
    if (this.requests > 0 && this.priced === this.requests) out.costUsd = Math.round(this.cost * 1e9) / 1e9;
    return out;
  }
}

export abstract class HttpEngine implements Engine {
  abstract readonly id: EngineId;
  readonly caps: EngineCaps = { sessions: false, dynamicTools: true, mcp: false, images: true, rebase: false, structured: true, ownTools: false, trace: true };
  protected readonly fetchFn: FetchFn;
  protected readonly deps: HttpEngineDeps;
  /** runId → steered text waiting for the next request (only while that turn runs). */
  private readonly steering = new Map<string, string[]>();

  constructor(deps: HttpEngineDeps) {
    this.deps = deps;
    this.fetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
  }

  protected abstract authHeaders(key: string | undefined): Record<string, string>;
  /** Prepares provider state for a turn; `step` runs one request; `addResults` appends tool results. */
  protected abstract startConversation(input: EngineTurnInput, names: ToolNames, base: string): Promise<{
    step(key: string | undefined, emit: (e: EngineEvent) => void): Promise<LoopStep>;
    addResults(results: Array<{ id: string; name: string; output: ToolOutput }>): void;
    /** Steering: one more user message before the next request. */
    addUserText?(text: string): void;
    /** The subconscious's calls as real tool calls with their outputs, in this API's wire format. */
    injectTrace(calls: readonly TraceCall[]): void;
  }>;

  /** Queues text for the running turn `runId` (its next request); false when that turn is not running here. */
  async steer(runId: string, text: string): Promise<boolean> {
    const queue = this.steering.get(runId);
    if (!queue || !text.trim()) return false;
    queue.push(text);
    return true;
  }

  /** Adds the waiting steered text to the conversation; true when there was some. */
  private takeSteered(runId: string, convo: { addUserText?(text: string): void }): boolean {
    const queue = this.steering.get(runId);
    if (!queue?.length || !convo.addUserText) return false;
    convo.addUserText(queue.splice(0).join('\n\n'));
    return true;
  }

  protected keyRequired(account: Account): boolean {
    return !LOCAL_PROVIDERS.has(account.provider) && account.provider !== 'compatible';
  }

  protected async image(path: string): Promise<string> {
    const data = await (this.deps.readFile ?? ((p: string) => fsp.readFile(p)))(path);
    return Buffer.from(data).toString('base64');
  }

  /** MM10: a recording as base64, or undefined when it is larger than AUDIO_INPUT_BYTES. */
  protected async audio(path: string): Promise<string | undefined> {
    const data = await (this.deps.readFile ?? ((p: string) => fsp.readFile(p)))(path);
    return data.byteLength <= AUDIO_INPUT_BYTES ? Buffer.from(data).toString('base64') : undefined;
  }

  async listModels(account: Account): Promise<EngineModel[]> {
    const base = endpointFor(account);
    const key = await this.deps.apiKey(account);
    let response: Response;
    try {
      response = await this.fetchFn(`${base}${this.modelsPath()}`, { headers: { Accept: 'application/json', ...this.authHeaders(key) }, redirect: 'error', signal: AbortSignal.timeout(12_000) });
    } catch { throw new HttpEngineError({ code: 'unavailable', message: 'Could not reach the provider. Check the connection and try again.' }); }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new HttpEngineError(statusError(response.status)); }
    const data = await readJson(response) as { data?: unknown };
    if (!Array.isArray(data?.data)) throw new HttpEngineError({ code: 'unavailable', message: 'The server did not return a supported model list.' });
    const ids = data.data
      .map((m) => (m && typeof m === 'object' ? (m as { id?: unknown; display_name?: unknown }) : {}))
      .filter((m): m is { id: string; display_name?: unknown } => typeof m.id === 'string' && m.id.length <= 200 && (!key || !m.id.includes(key)))
      .slice(0, 500)
      .sort((a, b) => a.id.localeCompare(b.id));
    return ids.map((m) => ({ model: m.id, name: typeof m.display_name === 'string' ? m.display_name.slice(0, 200) : m.id, efforts: this.effortsFor(m.id) }));
  }

  protected effortsFor(_model: string): EngineModel['efforts'] {
    return ['none'];
  }

  /** Path (and query) of the model list below the base URL. */
  protected modelsPath(): string {
    return '/models';
  }

  async checkAccount(account: Account): Promise<AccountCheck> {
    const key = await this.deps.apiKey(account).catch(() => undefined);
    if (!key && this.keyRequired(account)) return { state: 'needs_login', message: 'Add an API key for this connection.' };
    try {
      const models = await this.listModels(account);
      return models.length ? { state: 'ok', plan: LOCAL_PROVIDERS.has(account.provider) ? 'local' : 'api' } : { state: 'error', message: 'The server is reachable, but no models are available.' };
    } catch (error) {
      const data = error instanceof HttpEngineError ? error.data : undefined;
      if (data?.code === 'rate_limited') return { state: 'cooling', message: data.message };
      if (data?.message.startsWith('The provider rejected')) return { state: 'needs_login', message: data.message };
      return { state: 'error', message: data?.message ?? (error instanceof Error ? error.message : 'The connection check failed.') };
    }
  }

  async run(input: EngineTurnInput): Promise<EngineTurnResult> {
    const emit = (event: EngineEvent) => { try { input.onEvent(event); } catch { /* isolate */ } };
    let key: string | undefined;
    let base: string;
    try {
      base = endpointFor(input.account);
      key = await this.deps.apiKey(input.account);
    } catch (error) {
      return { text: '', stop: 'error', error: { code: 'bad_request', message: error instanceof Error ? error.message : 'Invalid connection.' } };
    }
    if (!key && this.keyRequired(input.account)) return { text: '', stop: 'error', error: { code: 'unavailable', message: 'Add an API key for this connection.' } };
    const names = new ToolNames(input.tools);
    const usage = new TurnUsage();
    const texts: string[] = [];
    // Redact any echoed key from what reaches the UI.
    const safeEmit = (event: EngineEvent) => emit(event.type === 'text' || event.type === 'reasoning' ? { ...event, delta: redact(event.delta, key) } : event);
    try {
      const convo = await this.startConversation(input, names, base);
      if (hasTrace(input.trace)) convo.injectTrace(input.trace.calls);
      if (convo.addUserText && !input.outputSchema) this.steering.set(input.runId, []); // helper decisions are never steered
      let paused = false; // the provider paused the turn: resume it unchanged
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        input.signal.throwIfAborted();
        if (!paused) this.takeSteered(input.runId, convo);
        const step = await convo.step(key, safeEmit);
        usage.add(step.usage);
        if (step.text) texts.push(step.text);
        paused = step.continue === true;
        if (step.continue) continue;
        if (step.done || !step.calls.length) {
          // A message arrived while it answered: it answers that too (not after a cut-off tool call – it has no result).
          if (!step.calls.length && this.takeSteered(input.runId, convo)) continue;
          const text = redact(texts.join('\n\n'), key).trim();
          return { text, stop: 'done', usage: usage.result(), structured: input.outputSchema ? step.structured : undefined };
        }
        const results: Array<{ id: string; name: string; output: ToolOutput }> = [];
        for (const call of step.calls) {
          const name = names.ours(call.name);
          let output: ToolOutput;
          if (!name) output = { content: [{ type: 'text', text: `Unknown tool: ${call.name}` }], isError: true };
          else if (this.steering.get(input.runId)?.length) output = { content: [{ type: 'text', text: NOT_RUN_STEERED }], isError: true }; // decided before the new message
          else {
            safeEmit({ type: 'tool_start', callId: call.id, name, args: call.args, own: false });
            output = await safeCall(input.callTool, name, call.args, call.id);
            safeEmit({ type: 'tool_end', callId: call.id, ok: !output.isError, summary: outputText(output, 120) });
          }
          results.push({ id: call.id, name: call.name, output });
        }
        convo.addResults(results);
      }
      return { text: redact(texts.join('\n\n'), key).trim(), stop: 'error', usage: usage.result(), error: { code: 'internal', message: 'The model used too many tool calls in one turn.' } };
    } catch (error) {
      // A cut-off or refused answer was still billed: keep its tokens (and a reported cost) in the turn's usage.
      if (error instanceof HttpEngineError && error.usage) usage.add(error.usage as StepUsage);
      const failed = turnError(error, input.signal);
      return { text: redact(texts.join('\n\n'), key).trim(), usage: usage.result(), ...failed };
    } finally {
      this.steering.delete(input.runId); // a turn that ended without taking it: the dispatcher's cursor brings it next turn
    }
  }

  async dispose(): Promise<void> {}
}

type TextPart = { type: 'text'; text: string };
type ImagePart = { type: 'image'; path: string; mime: string };
export type AudioPart = { type: 'audio'; path: string; name: string; mime: string; text?: string };

/** MM10: what reaches a model that cannot hear a recording. */
export function audioNote(item: { name: string; mime: string; text?: string }): string {
  return `[audio: ${item.name} (${item.mime}) – not heard: this model takes no audio]${item.text ? `\n${item.text}` : ''}`;
}

/**
 * Renders the stateless turn input into text + images (projection is already in input.input);
 * recordings stay audio parts only for an adapter that asks for them (`audio: true`), else a note.
 */
export function splitInput(input: EngineTurnInput['input']): { parts: Array<TextPart | ImagePart> };
export function splitInput(input: EngineTurnInput['input'], options: { audio: true }): { parts: Array<TextPart | ImagePart | AudioPart> };
export function splitInput(input: EngineTurnInput['input'], options: { audio?: boolean } = {}): { parts: Array<TextPart | ImagePart | AudioPart> } {
  return {
    parts: input.map((item): TextPart | ImagePart | AudioPart => {
      if (item.type === 'file') return { type: 'text', text: `[file: ${item.name} (${item.mime})]${item.text ? `\n${item.text}` : ''}` };
      if (item.type === 'audio') return options.audio ? item : { type: 'text', text: audioNote(item) };
      return item;
    }),
  };
}
