// Parser for Claude Code `--output-format stream-json --verbose --include-partial-messages`.
// Owns: mapping stream lines (system/init, stream_event deltas, assistant/user messages with
// tool_use/tool_result, rate_limit_event, result incl. modelUsage context windows) to
// EngineEvents and a final turn summary (usage over every result of the turn – a steered line may get
// its own; inputTokens counts cache reads and writes, which also stand on their own), and how a failed turn ended (limit, signed out).
// D5: thinking blocks are reasoning with an id per block (content_block_start/stop of streamed
// thinking; a full message's thinking block when no deltas came – empty or redacted thinking shows nothing).
// B-048: a thinking block's signature (signature_delta or the full block's) rides on its reasoning_end; a
// tool_result's full content (bounded 64k) on tool_end.output; system/init's claude_code_version is kept.
// B-049 F6: a system/compact_boundary (the CLI compacted the session) is kept as state.compacted.
// Final text excludes main-thread updates before tools (emitted as commentary);
// subagent lines (`parent_tool_use_id` set) never reach the answer, the live text or the usage.
// Never: spawns processes or writes to stdin.

import type { AccountLimits } from '../../../shared/model/providers.ts';
import type { CacheTokens, EngineEvent } from '../types.ts';
import { addCache, isRecord, num, str } from '../shared.ts';
import { parseClaudeRateLimitEvent } from '../../accounts/limits.ts';
import { boundOutput } from '../output.ts';

/** Our hub's MCP server name; its tools are ours (executed by the hub, not by Claude). */
export const HUB_SERVER = 'workforce';

export interface ClaudeTurnState {
  sessionId?: string;
  text: string; // streamed text of the whole turn (live view)
  answer: string[]; // completed main-thread answer blocks after the latest tool round
  finalText?: string; // `result.result` (text of the last assistant message only)
  done: boolean;
  isError: boolean;
  subtype?: string;
  /** inputTokens: all input, cache reads and writes included (the turn's totals count on it); the cache parts beside it, when reported. */
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number } & CacheTokens;
  contextTokens?: number;
  /** Context window per model id from `result.modelUsage`. */
  contextWindows: Record<string, number>;
  structured?: unknown;
  rejected: boolean;
  resetsAt?: number;
  limits?: AccountLimits;
  errorText?: string;
  /** `error` of a main-thread assistant message ("authentication_failed", "rate_limit" …). */
  assistantError?: string;
  /** B-048: the CLI's version from system/init (`claude_code_version`). */
  version?: string;
  /** B-049 F6: a main-thread system/compact_boundary – Claude Code compacted the session's history in this turn. */
  compacted?: boolean;
}

export function newClaudeState(): ClaudeTurnState {
  return { text: '', answer: [], contextWindows: {}, done: false, isError: false, rejected: false };
}

const HUB_PREFIX = `mcp__${HUB_SERVER}__`;

/** The turn's cost after another result: the CLI's running total, or the sum when the reported total went down. */
function laterCost(before: number | undefined, now: number | undefined): number | undefined {
  if (now === undefined) return before;
  if (before === undefined) return now;
  return now >= before ? now : Math.round((before + now) * 1e9) / 1e9;
}

/** The text of an error result: `result` when it is a string, else the `errors` strings (at most 500 chars). */
function errorTextOf(message: Record<string, unknown>): string | undefined {
  const parts = typeof message.result === 'string' && message.result ? [message.result]
    : Array.isArray(message.errors) ? message.errors.filter((entry): entry is string => typeof entry === 'string') : [];
  const text = parts.join('\n').slice(0, 500);
  return text || undefined;
}

/** Our dotted tool name for a hub wire name ("tasks__create" → "tasks.create", see toWireName). */
function hubToolName(wire: string): string {
  return wire.replace(/__/g, '.');
}

export class ClaudeStreamParser {
  readonly state = newClaudeState();
  private readonly emit: (event: EngineEvent) => void;
  private readonly now: () => number;
  private streamedText = false; // partial deltas seen → do not re-emit full assistant text
  private messageId = ''; // the streamed main-thread message (message_start), for reasoning block ids
  private readonly thinking = new Map<number, string>(); // open streamed thinking block: content index → reasoning id
  private readonly signatures = new Map<number, string>(); // B-048: open thinking block's signature (signature_delta)
  private readonly streamedThinking = new Set<string>(); // message ids whose thinking arrived as deltas ('*': id unknown)
  private readonly fullThinking = new Set<string>(); // thinking blocks taken from full messages (the CLI may repeat a message)
  private readonly tools = new Map<string, string>(); // tool_use id → name
  private readonly answered = new Set<string>(); // message id + text: a block repeated by the CLI counts once
  private hadCommentary = false;

  constructor(emit: (event: EngineEvent) => void, now: () => number) {
    this.emit = emit;
    this.now = now;
  }

  /** Final answer blocks, else `result.result` (never an error text or a streamed work update). */
  answer(): string {
    const s = this.state;
    return s.answer.join('\n\n').trim() || (s.isError ? '' : (s.finalText ?? '').trim()) || (this.hadCommentary ? '' : s.text.trim());
  }

  push(message: unknown): void {
    if (!isRecord(message)) return;
    const s = this.state;
    const sub = typeof message.parent_tool_use_id === 'string' && message.parent_tool_use_id !== ''; // subagent (Task) traffic
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init' && str(message.session_id)) s.sessionId = message.session_id as string;
        if (message.subtype === 'init' && str(message.claude_code_version)) s.version = message.claude_code_version as string;
        if (message.subtype === 'compact_boundary' && !sub) s.compacted = true; // B-049 F6: the session's history was compacted
        break;
      case 'stream_event': {
        if (sub) break;
        const event = isRecord(message.event) ? message.event : {};
        const delta = isRecord(event.delta) ? event.delta : {};
        if (event.type === 'content_block_delta' && delta.type === 'text_delta' && typeof delta.text === 'string') {
          this.streamedText = true;
          s.text += delta.text;
          this.emit({ type: 'text', delta: delta.text });
        } else if (event.type === 'content_block_delta' && delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
          const id = this.thinking.get(num(event.index) ?? -1);
          this.streamedThinking.add(this.messageId || '*');
          this.emit({ type: 'reasoning', delta: delta.thinking, ...(id ? { id } : {}) });
        } else if (event.type === 'content_block_delta' && delta.type === 'signature_delta' && typeof delta.signature === 'string') {
          const index = num(event.index) ?? -1; // B-048: the block's signature, so the thinking can be replayed unchanged
          if (this.thinking.has(index)) this.signatures.set(index, (this.signatures.get(index) ?? '') + delta.signature);
        } else if (event.type === 'content_block_start' && isRecord(event.content_block) && event.content_block.type === 'thinking') {
          const index = num(event.index) ?? 0; // D5: a thinking block's boundaries (redacted_thinking has no text: skipped)
          this.thinking.set(index, `${this.messageId || 'm'}:${index}`);
          if (str(event.content_block.signature)) this.signatures.set(index, event.content_block.signature as string);
        } else if (event.type === 'content_block_stop' && this.thinking.has(num(event.index) ?? -1)) {
          const index = num(event.index) ?? -1;
          const signature = this.signatures.get(index);
          this.emit({ type: 'reasoning_end', id: this.thinking.get(index)!, ...(signature ? { signature } : {}) });
          this.thinking.delete(index);
          this.signatures.delete(index);
        } else if (event.type === 'message_start' && isRecord(event.message)) {
          this.messageId = str(event.message.id) ?? '';
          this.thinking.clear();
          this.signatures.clear();
          const u = isRecord(event.message.usage) ? event.message.usage : undefined;
          if (u) s.contextTokens = (num(u.input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0);
        }
        break;
      }
      case 'assistant': {
        const msg = isRecord(message.message) ? message.message : {};
        const content = Array.isArray(msg.content) ? msg.content : [];
        if (!sub && typeof message.error === 'string' && message.error) s.assistantError = message.error.slice(0, 80);
        for (const [index, block] of content.entries()) {
          if (!isRecord(block)) continue;
          if (block.type === 'thinking') {
            // D5 fallback: a thinking block that arrived only in the full message (no partial deltas).
            // Current models may omit the text (empty thinking): nothing is shown then, never a fake.
            const text = typeof block.thinking === 'string' ? block.thinking : '';
            const key = `${str(msg.id) ?? ''}\u0000${text}`;
            if (!sub && text.trim() && !this.streamedThinking.has(str(msg.id) ?? '') && !this.streamedThinking.has('*') && !this.fullThinking.has(key)) {
              this.fullThinking.add(key);
              const id = `${str(msg.id) ?? 'm'}:t${this.fullThinking.size}:${index}`;
              this.emit({ type: 'reasoning', delta: text, id });
              this.emit({ type: 'reasoning_end', id, ...(str(block.signature) ? { signature: block.signature as string } : {}) });
            }
          } else if (block.type === 'text' && typeof block.text === 'string') {
            if (sub) continue;
            const key = `${str(msg.id) ?? ''}\u0000${block.text}`;
            if (block.text.trim() && !this.answered.has(key)) { this.answered.add(key); s.answer.push(block.text); }
            if (this.streamedText) continue;
            s.text += (s.text ? '\n\n' : '') + block.text;
            this.emit({ type: 'text', delta: block.text });
          } else if (block.type === 'tool_use') {
            if (!sub && s.answer.length) {
              const text = s.answer.splice(0).join('\n\n').trim();
              if (text) { this.hadCommentary = true; this.emit({ type: 'commentary', text }); }
            }
            const id = str(block.id) ?? '';
            const name = str(block.name) ?? 'tool';
            this.tools.set(id, name);
            const ours = name.startsWith(HUB_PREFIX);
            this.emit({ type: 'tool_start', callId: id, name: ours ? hubToolName(name.slice(HUB_PREFIX.length)) : name, args: block.input, own: !ours });
            if (!ours) this.emit({ type: 'status', note: name === 'Bash' && isRecord(block.input) ? `running ${String(block.input.command ?? '').slice(0, 60)}` : `using ${name}` });
          }
        }
        // A new assistant message after a tool round: separate paragraphs in the streamed text.
        if (!sub && this.streamedText && s.text && !s.text.endsWith('\n\n')) s.text += '\n\n';
        break;
      }
      case 'user': {
        const content = isRecord(message.message) && Array.isArray(message.message.content) ? message.message.content : [];
        for (const block of content) {
          if (!isRecord(block) || block.type !== 'tool_result') continue;
          const id = str(block.tool_use_id) ?? '';
          const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map((c) => (isRecord(c) && typeof c.text === 'string' ? c.text : '')).join('\n') : '';
          // B-048 E1/E2: the full result (bounded) for the ledger; the summary stays the short line.
          this.emit({ type: 'tool_end', callId: id, ok: block.is_error !== true, summary: text.slice(0, 120), ...(text ? { output: boundOutput(text) } : {}) });
        }
        break;
      }
      case 'rate_limit_event': {
        const info = parseClaudeRateLimitEvent(message, this.now());
        if (info.rejected) { s.rejected = true; s.resetsAt = info.resetsAt; }
        if (info.limits) { s.limits = info.limits; this.emit({ type: 'limits', limits: info.limits }); }
        break;
      }
      case 'result': {
        s.done = true;
        s.subtype = str(message.subtype);
        s.isError = message.is_error === true || (s.subtype !== undefined && s.subtype !== 'success');
        if (str(message.session_id)) s.sessionId = message.session_id as string;
        if (typeof message.result === 'string') s.finalText = message.result;
        // An error result carries its text in `result` or (2.1.303, e.g. a --resume of an unknown
        // session: subtype error_during_execution) only in `errors` – verified live 23.10.
        if (s.isError) s.errorText = errorTextOf(message);
        if ('structured_output' in message) s.structured = message.structured_output;
        if (isRecord(message.modelUsage)) {
          for (const [model, entry] of Object.entries(message.modelUsage)) {
            const window = isRecord(entry) ? num(entry.contextWindow) : undefined;
            if (window && window > 0) s.contextWindows[model] = window;
          }
        }
        const u = isRecord(message.usage) ? message.usage : {};
        const cache = { cacheReadTokens: num(u.cache_read_input_tokens), cacheWriteTokens: num(u.cache_creation_input_tokens) };
        const step = {
          inputTokens: (num(u.input_tokens) ?? 0) + (cache.cacheReadTokens ?? 0) + (cache.cacheWriteTokens ?? 0),
          outputTokens: num(u.output_tokens) ?? 0,
          costUsd: num(message.total_cost_usd),
          ...addCache(cache, {}),
        };
        // A steered line answered as its own result (engine.ts, 17:09): each result's usage covers its
        // own query, so tokens add up; total_cost_usd is the CLI process's running total, so the last
        // one counts – unless it went down (then it was per result and they add up). Not verified live.
        const before = s.usage;
        s.usage = before
          ? { inputTokens: before.inputTokens + step.inputTokens, outputTokens: before.outputTokens + step.outputTokens, costUsd: laterCost(before.costUsd, step.costUsd), ...addCache(before, step) }
          : step;
        this.emit({ type: 'usage', inputTokens: s.usage.inputTokens, outputTokens: s.usage.outputTokens, ...addCache(s.usage, {}), contextTokens: s.contextTokens, costUsd: s.usage.costUsd });
        break;
      }
    }
  }

  /** The reported window of `model` (exact id, a dated variant of it, or the only model reported). */
  contextWindow(model: string): number | undefined {
    const windows = this.state.contextWindows;
    const exact = windows[model] ?? Object.entries(windows).find(([id]) => id.startsWith(`${model}-`) || id.startsWith(`${model}[`))?.[1];
    if (exact !== undefined) return exact;
    const all = Object.values(windows);
    return all.length === 1 ? all[0] : undefined;
  }

  /** Did the turn end because of a usage limit? */
  limited(): boolean {
    const s = this.state;
    return s.rejected || s.assistantError === 'rate_limit' || (s.isError && /usage limit|rate limit|limit reached|out of extra usage/i.test(s.errorText ?? ''));
  }

  /** Did the turn fail because this account is not signed in (or its login was rejected)? */
  signedOut(): boolean {
    const s = this.state;
    return s.assistantError === 'authentication_failed' || (s.isError && /not logged in|\/login|authenticat/i.test(s.errorText ?? ''));
  }
}
