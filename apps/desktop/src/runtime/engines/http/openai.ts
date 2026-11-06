// OpenAI Responses API engine (also usable with SIWC tokens later).
// Owns: request shape (instructions, input items, function tools, reasoning.effort + summary,
// store:false, stream:true, encrypted reasoning carried between tool rounds) and SSE parsing
// (reasoning summaries per output item with section breaks, D5). B-078: the agent's temperature goes to models without
// reasoning; the reasoning families (gpt-5+, o-series) refuse the field, so it stays out there.
// Never: uses previous_response_id (stateless: the full projection is sent each turn).

import type { EngineId, Effort } from '../../../shared/model/providers.ts';
import type { EngineEvent, EngineTurnInput } from '../types.ts';
import type { ToolOutput } from '../../tools/types.ts';
import { traceCallId, type TraceCall } from '../../../shared/model/subconscious.ts';
import { ToolNames, isRecord, num, outputImages, outputText, str, tryJson } from '../shared.ts';
import { HttpEngine, splitInput, type LoopStep } from './base.ts';
import { HttpEngineError, postJson, readSse } from './common.ts';

const LIMIT_CODES = /usage_limit|rate_limit|insufficient_quota|subscription_sharing_usage/;
/** The reasoning families: they take reasoning.effort and refuse a temperature. */
const REASONING = /^(gpt-5|gpt-6|o\d)/;

/** Reasoning models outside those families (codex-mini-latest): they refuse a temperature too. */
const NO_TEMPERATURE = /^codex-/;

/** B-078 (D14, D16): the temperature this model gets on the Responses API (0..2), undefined where it is dropped (reasoning models, none asked). */
export function openAiTemperature(model: string, value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || REASONING.test(model) || NO_TEMPERATURE.test(model)) return undefined;
  return Math.max(0, Math.min(2, value));
}

export class OpenAiEngine extends HttpEngine {
  readonly id: EngineId = 'openai';

  protected authHeaders(key: string | undefined): Record<string, string> {
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  protected override effortsFor(model: string): Effort[] {
    return REASONING.test(model) ? ['none', 'low', 'medium', 'high', 'xhigh'] : ['none'];
  }

  protected async startConversation(input: EngineTurnInput, names: ToolNames, base: string) {
    const content: Array<Record<string, unknown>> = [];
    for (const part of splitInput(input.input).parts) {
      if (part.type === 'text') content.push({ type: 'input_text', text: part.text });
      else content.push({ type: 'input_image', image_url: `data:${part.mime};base64,${await this.image(part.path)}` });
    }
    const items: unknown[] = [{ role: 'user', content: content.length ? content : [{ type: 'input_text', text: '(continue)' }] }];
    const tools = input.tools.map((tool) => ({ type: 'function', name: names.wire(tool.name), description: tool.description, parameters: tool.inputSchema, strict: false }));
    const body: Record<string, unknown> = {
      model: input.model,
      instructions: [input.system.stable, input.system.volatile].filter(Boolean).join('\n\n'),
      store: false, stream: true,
      include: ['reasoning.encrypted_content'],
    };
    if (tools.length) body.tools = tools;
    if (input.effort !== 'none') body.reasoning = { effort: input.effort === 'max' ? 'xhigh' : input.effort, summary: 'auto' };
    const temperature = openAiTemperature(input.model, input.temperature);
    if (temperature !== undefined) body.temperature = temperature;
    if (input.outputSchema) body.text = { format: { type: 'json_schema', name: 'result', schema: input.outputSchema, strict: false } };

    const step = async (key: string | undefined, emit: (e: EngineEvent) => void): Promise<LoopStep> => {
      const response = await postJson(this.fetchFn, `${base}/responses`, { Accept: 'text/event-stream', ...this.authHeaders(key) }, { ...body, input: items }, input.signal);
      let text = '';
      let final: Record<string, unknown> | undefined;
      const outputs: Record<string, unknown>[] = [];
      for await (const { data } of readSse(response)) {
        if (!isRecord(data)) continue;
        const type = str(data.type);
        if (type === 'response.output_text.delta' && typeof data.delta === 'string') { text += data.delta; emit({ type: 'text', delta: data.delta }); }
        // D5: reasoning per output item (item_id); a later summary part is a section break; the item's end closes the block.
        else if (type === 'response.reasoning_summary_text.delta' && typeof data.delta === 'string') emit({ type: 'reasoning', delta: data.delta, ...(str(data.item_id) ? { id: str(data.item_id) } : {}) });
        else if (type === 'response.reasoning_summary_part.added' && (num(data.summary_index) ?? 0) > 0) emit({ type: 'reasoning', delta: '\n\n', ...(str(data.item_id) ? { id: str(data.item_id) } : {}) });
        else if (type === 'response.output_item.done' && isRecord(data.item)) {
          outputs.push(data.item);
          if (data.item.type === 'reasoning') emit({ type: 'reasoning_end', ...(str(data.item.id) ? { id: str(data.item.id) } : {}) });
        }
        else if (type === 'response.completed' && isRecord(data.response)) final = data.response;
        else if (type === 'response.failed' || type === 'response.incomplete' || type === 'error') {
          const err = isRecord(data.response) && isRecord(data.response.error) ? data.response.error : data;
          const code = String(err.code ?? '');
          if (LIMIT_CODES.test(code)) throw new HttpEngineError({ code: 'rate_limited', message: 'The usage limit of this account was reached.' });
          const u = isRecord(data.response) && isRecord(data.response.usage) ? data.response.usage : undefined;
          throw new HttpEngineError({ code: 'internal', message: type === 'response.incomplete' ? 'The model response was cut off.' : 'The model could not complete this turn.' },
            u ? { inputTokens: num(u.input_tokens) ?? 0, outputTokens: num(u.output_tokens) ?? 0 } : undefined);
        }
      }
      if (!final) throw new HttpEngineError({ code: 'internal', message: 'The model response did not complete.' });
      const output = Array.isArray(final.output) ? final.output.filter(isRecord) : outputs;
      // Carry every output item (reasoning with encrypted content, messages, calls) into the next round.
      // With store:false, item ids cannot be resolved server-side; only reasoning keeps its id.
      items.push(...output.map((item) => {
        if (item.type === 'reasoning') return item;
        const { id: _id, status: _status, ...rest } = item;
        return rest;
      }));
      const calls = output.filter((item) => item.type === 'function_call').map((item) => ({ id: str(item.call_id) ?? '', name: str(item.name) ?? '', args: tryJson(str(item.arguments) ?? '{}') ?? {} }));
      const u = isRecord(final.usage) ? final.usage : {};
      return { text, calls, done: calls.length === 0, usage: { inputTokens: num(u.input_tokens) ?? 0, outputTokens: num(u.output_tokens) ?? 0 }, structured: input.outputSchema ? tryJson(text.trim()) : undefined };
    };

    const addResults = (results: Array<{ id: string; name: string; output: ToolOutput }>) => {
      const images: Array<Record<string, unknown>> = [];
      for (const r of results) {
        items.push({ type: 'function_call_output', call_id: r.id, output: (r.output.isError ? 'ERROR: ' : '') + (outputText(r.output) || 'ok') });
        for (const img of outputImages(r.output)) images.push({ type: 'input_image', image_url: `data:${img.mime};base64,${img.dataBase64}` });
      }
      if (images.length) items.push({ role: 'user', content: [{ type: 'input_text', text: 'Images returned by the tool calls above:' }, ...images] });
    };
    const addUserText = (text: string) => { items.push({ role: 'user', content: [{ type: 'input_text', text }] }); }; // steering (base.ts)
    const injectTrace = (calls: readonly TraceCall[]) => {
      calls.forEach((call, index) => {
        const id = traceCallId(input.runId, index);
        items.push({ type: 'function_call', call_id: id, name: names.wire(call.tool), arguments: JSON.stringify(call.args) }, { type: 'function_call_output', call_id: id, output: call.output });
      });
    };
    return { step, addResults, addUserText, injectTrace };
  }
}
