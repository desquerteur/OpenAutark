// OpenAI-compatible Chat Completions engine: Ollama, LM Studio, llama.cpp, vLLM, OpenRouter,
// Gemini/xAI/DeepSeek compat endpoints and any custom server.
// Owns: messages/tools request shape (B-078: with the temperature an agent asked for), streamed delta + tool_call assembly, reasoning deltas, and
// OpenRouter's own price of each request (PR9: asked for with `usage: {include: true}`; with a
// bring-your-own-key the upstream provider's inference cost counts too). MM10: the only adapter
// that sends recordings – an audio part becomes `input_audio` (WAV or MP3, ≤ 10 MB, base64), then
// its text; the OpenAI API speaks this format too, so media.listen runs OpenAI models through it.
// Never: sends reasoning or usage params to servers that may reject unknown fields (only known
// providers), reads a cost field of any other server (its meaning is unknown), or sends audio in
// another format or above the limit (a note says why instead).
// Untested live against each server: field support varies (tool-call quality, usage, reasoning).

import type { EngineId } from '../../../shared/model/providers.ts';
import type { EngineEvent, EngineTurnInput } from '../types.ts';
import type { ToolOutput } from '../../tools/types.ts';
import { traceCallId, type TraceCall } from '../../../shared/model/subconscious.ts';
import { ToolNames, isRecord, num, outputImages, outputText, str, tryJson } from '../shared.ts';
import { AUDIO_INPUT_BYTES, HttpEngine, audioFormat, splitInput, type AudioPart, type LoopStep, type StepUsage } from './base.ts';
import { HttpEngineError, postJson, readSse } from './common.ts';

/** Providers known to accept `reasoning_effort` on chat completions. */
const REASONING_EFFORT = new Set(['google', 'xai', 'ollama', 'vllm', 'deepseek']);
const MAX_REQUEST_USD = 10_000; // a larger "cost" of one request is no price

/** OpenRouter's `usage.cost` in USD (credits) plus, with BYOK, the upstream inference cost; undefined when absent or implausible. */
export function openRouterCost(usage: Record<string, unknown>): number | undefined {
  const cost = num(usage.cost);
  if (cost === undefined || cost < 0) return undefined;
  const upstream = usage.is_byok === true && isRecord(usage.cost_details) ? num(usage.cost_details.upstream_inference_cost) : undefined;
  const total = cost + (upstream !== undefined && upstream > 0 ? upstream : 0);
  return total <= MAX_REQUEST_USD ? total : undefined;
}

function usageOf(raw: Record<string, unknown>, provider: string): StepUsage {
  const usage: StepUsage = { inputTokens: num(raw.prompt_tokens) ?? 0, outputTokens: num(raw.completion_tokens) ?? 0 };
  const cost = provider === 'openrouter' ? openRouterCost(raw) : undefined;
  if (cost !== undefined) usage.costUsd = cost;
  return usage;
}

export class CompatibleEngine extends HttpEngine {
  readonly id: EngineId = 'compatible';

  protected authHeaders(key: string | undefined): Record<string, string> {
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  /** MM10: the chat completions parts of a recording (then its `text`), or a note why it is not sent. */
  private async inputAudio(part: AudioPart): Promise<Array<Record<string, unknown>>> {
    const format = audioFormat(part.mime, part.name);
    const data = format ? await this.audio(part.path) : undefined;
    if (format && data) return [{ type: 'input_audio', input_audio: { data, format } }, ...(part.text ? [{ type: 'text', text: part.text }] : [])];
    const why = format ? `larger than ${AUDIO_INPUT_BYTES / 1024 / 1024} MB` : 'only WAV and MP3 can be sent';
    return [{ type: 'text', text: `[audio: ${part.name} (${part.mime}) – not sent: ${why}]${part.text ? `\n${part.text}` : ''}` }];
  }

  protected async startConversation(input: EngineTurnInput, names: ToolNames, base: string) {
    const parts: Array<Record<string, unknown>> = [];
    let media = 0; // images and recordings need a list of parts
    for (const part of splitInput(input.input, { audio: true }).parts) {
      if (part.type === 'text') parts.push({ type: 'text', text: part.text });
      else if (part.type === 'image') { media++; parts.push({ type: 'image_url', image_url: { url: `data:${part.mime};base64,${await this.image(part.path)}` } }); }
      else {
        const sound = await this.inputAudio(part);
        if (sound[0].type === 'input_audio') media++;
        parts.push(...sound);
      }
    }
    // Plain string content where possible: many local servers only accept strings.
    const userContent = media ? parts : parts.map((p) => String(p.text ?? '')).join('\n\n') || '(continue)';
    const system = [input.system.stable, input.system.volatile].filter(Boolean).join('\n\n');
    const messages: Array<Record<string, unknown>> = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: userContent });
    const provider = input.account.provider;
    const body: Record<string, unknown> = { model: input.model, stream: true, stream_options: { include_usage: true } };
    if (input.tools.length) body.tools = input.tools.map((tool) => ({ type: 'function', function: { name: names.wire(tool.name), description: tool.description, parameters: tool.inputSchema } }));
    if (input.effort !== 'none') {
      const effort = input.effort === 'max' || input.effort === 'xhigh' ? 'high' : input.effort;
      if (provider === 'openrouter') body.reasoning = { effort };
      else if (REASONING_EFFORT.has(provider)) body.reasoning_effort = effort;
    }
    if (provider === 'openrouter') body.usage = { include: true }; // its own price per request (PR9)
    // B-078: the temperature the agent asked for (model.set) – every chat completions server takes this standard field
    if (typeof input.temperature === 'number' && Number.isFinite(input.temperature)) body.temperature = Math.max(0, Math.min(2, input.temperature));
    if (input.outputSchema) body.response_format = { type: 'json_schema', json_schema: { name: 'result', schema: input.outputSchema } };

    const step = async (key: string | undefined, emit: (e: EngineEvent) => void): Promise<LoopStep> => {
      const response = await postJson(this.fetchFn, `${base}/chat/completions`, { Accept: 'text/event-stream', ...this.authHeaders(key) }, { ...body, messages }, input.signal);
      let text = '';
      let finish: string | undefined;
      const calls = new Map<number, { id: string; name: string; args: string }>();
      let usage: StepUsage | undefined;
      for await (const { data } of readSse(response)) {
        if (data === '[DONE]') break;
        if (!isRecord(data)) continue;
        if (isRecord(data.error)) throw new HttpEngineError({ code: 'internal', message: 'The model could not complete this turn.' });
        if (isRecord(data.usage)) usage = usageOf(data.usage, provider);
        const choice = Array.isArray(data.choices) && isRecord(data.choices[0]) ? data.choices[0] : undefined;
        if (!choice) continue;
        finish = str(choice.finish_reason) ?? finish;
        const delta = isRecord(choice.delta) ? choice.delta : {};
        if (typeof delta.content === 'string' && delta.content) { text += delta.content; emit({ type: 'text', delta: delta.content }); }
        const reasoning = str(delta.reasoning_content) ?? str(delta.reasoning);
        if (reasoning) emit({ type: 'reasoning', delta: reasoning });
        if (Array.isArray(delta.tool_calls)) {
          for (const raw of delta.tool_calls) {
            if (!isRecord(raw)) continue;
            const index = num(raw.index) ?? calls.size;
            const call = calls.get(index) ?? { id: '', name: '', args: '' };
            if (str(raw.id)) call.id = raw.id as string;
            const fn = isRecord(raw.function) ? raw.function : {};
            if (str(fn.name)) call.name += fn.name as string;
            if (str(fn.arguments)) call.args += fn.arguments as string;
            calls.set(index, call);
          }
        }
      }
      if (!finish && !text && !calls.size) throw new HttpEngineError({ code: 'internal', message: 'The model response did not complete.' });
      const list = [...calls.values()].map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, args: tryJson(c.args || '{}') ?? {} }));
      const assistant: Record<string, unknown> = { role: 'assistant', content: text || null };
      if (list.length) assistant.tool_calls = list.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      messages.push(assistant);
      if (finish === 'length' && !list.length) throw new HttpEngineError({ code: 'internal', message: 'The model response was cut off.' }, usage);
      return { text, calls: list, done: list.length === 0, usage, structured: input.outputSchema ? tryJson(text.trim()) : undefined };
    };

    const addResults = (results: Array<{ id: string; name: string; output: ToolOutput }>) => {
      const images: Array<Record<string, unknown>> = [];
      for (const r of results) {
        messages.push({ role: 'tool', tool_call_id: r.id, content: (r.output.isError ? 'ERROR: ' : '') + (outputText(r.output) || 'ok') });
        for (const img of outputImages(r.output)) images.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.dataBase64}` } });
      }
      if (images.length) messages.push({ role: 'user', content: [{ type: 'text', text: 'Images returned by the tool calls above:' }, ...images] });
    };
    const addUserText = (text: string) => { messages.push({ role: 'user', content: text }); }; // steering (base.ts)
    const injectTrace = (calls: readonly TraceCall[]) => {
      messages.push({ role: 'assistant', content: null, tool_calls: calls.map((call, index) => ({ id: traceCallId(input.runId, index), type: 'function', function: { name: names.wire(call.tool), arguments: JSON.stringify(call.args) } })) });
      calls.forEach((call, index) => messages.push({ role: 'tool', tool_call_id: traceCallId(input.runId, index), content: call.output }));
    };
    return { step, addResults, addUserText, injectTrace };
  }
}
