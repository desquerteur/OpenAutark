// ACP session/update → EngineEvents, plus the other per-turn mappings: a permission request's
// answer (its optionId), a prompt stopReason → the turn's stop, prompt usage.
// Owns: the per-turn state (answer text with a paragraph break after tool calls, agent images as
// files, tool calls by id, context numbers), the strict "is this our hub tool" check and the option
// choice. Never: talks to the agent.

import type { EngineEvent, EngineFile, EngineTurnResult } from '../types.ts';
import type { WorkforceErrorData } from '../../../shared/errors.ts';
import { ERR, isRecord, num, str } from '../shared.ts';

/** Our hub's MCP server name (= MCP_SERVER_NAME in mcp/names.ts). */
export const HUB = 'workforce';

export interface AcpTurnState {
  text: string;
  files: EngineFile[];
  tools: Map<string, { name: string; own: boolean; ended: boolean }>;
  /** Tool call ids a permission request identified as hub tools (before their tool_call arrives). */
  hubCalls: Map<string, string>;
  toolSinceText: boolean;
  contextTokens?: number;
  contextWindow?: number;
}

export function newTurnState(): AcpTurnState {
  return { text: '', files: [], tools: new Map(), hubCalls: new Map(), toolSinceText: false };
}

const OWN_NAMES: Record<string, string> = {
  execute: 'shell', edit: 'edit_file', delete: 'delete_file', move: 'move_file', read: 'read_file',
  search: 'search', fetch: 'web_fetch', think: 'think', switch_mode: 'switch_mode',
};
/** Kinds with their own side effects: never treated as a hub tool, whatever the title says. */
const OWN_EFFECT_KINDS = new Set(['execute', 'edit', 'delete', 'move', 'switch_mode']);
const WIRE = '([A-Za-z0-9_-]{1,64})';
const HUB_TITLES = [new RegExp(`^mcp__${HUB}__${WIRE}$`), new RegExp(`^${HUB}__${WIRE}$`), new RegExp(`^${HUB}[/:]${WIRE}$`), new RegExp(`^${WIRE} \\(${HUB} MCP Server\\)$`)];
const MAX_FILES = 20;

/** Our dotted name for a hub wire name ("tasks__create" → "tasks.create"; see mcp/names.ts). */
export function hubToolName(wire: string): string {
  return wire.replace(/__/g, '.');
}

/**
 * The workforce tool a tool call names, or undefined. Strict on purpose: only an exact,
 * hub-qualified tool name (never a command or a title that merely contains one) and never a
 * kind that has effects of its own.
 */
export function hubToolOf(toolCall: Record<string, unknown>): string | undefined {
  const kind = str(toolCall.kind);
  if (kind && OWN_EFFECT_KINDS.has(kind)) return undefined;
  const meta = isRecord(toolCall._meta) && isRecord(toolCall._meta.claudeCode) ? str(toolCall._meta.claudeCode.toolName) : undefined;
  for (const candidate of [meta, str(toolCall.title)]) {
    const text = candidate?.trim();
    if (!text) continue;
    for (const pattern of HUB_TITLES) {
      const match = pattern.exec(text);
      if (match) return hubToolName(match[1]);
    }
  }
  return undefined;
}

/**
 * True when a permission request is about one of our hub tools: an exact hub tool name, or the
 * option Gemini CLI generates from the configured server name ("Always Allow workforce").
 */
export function isHubPermission(toolCall: Record<string, unknown>, options: unknown[]): boolean {
  if (hubToolOf(toolCall)) return true;
  const kind = str(toolCall.kind);
  if (kind && OWN_EFFECT_KINDS.has(kind)) return false;
  return options.some((option) => isRecord(option) && option.optionId === 'proceed_always_server' && option.name === `Always Allow ${HUB}`);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function endSummary(update: Record<string, unknown>, status: string): string {
  for (const item of Array.isArray(update.content) ? update.content : []) {
    if (!isRecord(item)) continue;
    if (item.type === 'content' && isRecord(item.content) && typeof item.content.text === 'string' && item.content.text.trim()) return clip(item.content.text, 120);
    if (item.type === 'diff' && typeof item.path === 'string') return clip(`changed ${item.path}`, 120);
  }
  return status;
}

function toolEvent(state: AcpTurnState, update: Record<string, unknown>, emit: (event: EngineEvent) => void): void {
  const callId = str(update.toolCallId) ?? '';
  let tool = state.tools.get(callId);
  if (!tool) {
    const ours = hubToolOf(update) ?? state.hubCalls.get(callId);
    const kind = str(update.kind) ?? '';
    const title = str(update.title);
    tool = { name: ours ?? OWN_NAMES[kind] ?? (title ? clip(title, 60) : 'tool'), own: !ours, ended: false };
    state.tools.set(callId, tool);
    state.toolSinceText = true;
    // D5: the agent's own human line for its call (e.g. "Read src/app.ts") travels as the step's title.
    // B-055 G: an own edit/delete/move/read names its files (locations + path keys) as `paths` – the work-presence ledger reads them (work-presence/touches.ts).
    const raw = isRecord(update.rawInput) ? update.rawInput : undefined;
    const files = tool.own && ['edit', 'delete', 'move', 'read'].includes(kind) ? pathsOf(update, raw ?? {}) : [];
    emit({ type: 'tool_start', callId, name: tool.name, args: files.length ? { ...raw, paths: files } : update.rawInput ?? {}, own: tool.own, ...(tool.own && title?.trim() ? { title: clip(title, 120) } : {}) });
    if (tool.own && kind === 'execute' && title) emit({ type: 'status', note: `running ${clip(title, 60)}` });
  }
  const status = str(update.status);
  if (!tool.ended && (status === 'completed' || status === 'failed')) {
    tool.ended = true;
    emit({ type: 'tool_end', callId, ok: status === 'completed', summary: endSummary(update, status) });
  }
}

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** Applies one `session/update` payload of the running turn. */
export function applyUpdate(state: AcpTurnState, update: Record<string, unknown>, emit: (event: EngineEvent) => void): void {
  switch (str(update.sessionUpdate)) {
    case 'agent_message_chunk': {
      const content = isRecord(update.content) ? update.content : {};
      if (content.type === 'text' && typeof content.text === 'string' && content.text) {
        // Text after a tool call starts a new paragraph (chunks carry no message boundaries).
        const delta = state.toolSinceText && state.text.trim() ? `\n\n${content.text.replace(/^\n+/, '')}` : content.text;
        state.toolSinceText = false;
        state.text += delta;
        emit({ type: 'text', delta });
      } else if (content.type === 'image' && typeof content.data === 'string' && state.files.length < MAX_FILES) {
        const mime = str(content.mimeType) ?? 'image/png';
        state.files.push({ name: `agent-image-${state.files.length + 1}.${IMAGE_EXT[mime] ?? 'png'}`, mime, dataBase64: content.data });
      }
      break;
    }
    case 'agent_thought_chunk': {
      const content = isRecord(update.content) ? update.content : {};
      if (content.type === 'text' && typeof content.text === 'string' && content.text) emit({ type: 'reasoning', delta: content.text });
      break;
    }
    case 'tool_call':
    case 'tool_call_update':
      toolEvent(state, update, emit);
      break;
    case 'plan': {
      const entries = Array.isArray(update.entries) ? update.entries.filter(isRecord) : [];
      emit({ type: 'plan', steps: entries.slice(0, 50).map((entry) => ({ text: String(entry.content ?? '').slice(0, 300), status: entry.status === 'completed' ? 'done' : entry.status === 'in_progress' ? 'active' : 'pending' })) });
      break;
    }
    case 'usage_update': {
      const used = num(update.used);
      state.contextWindow = num(update.size) ?? state.contextWindow;
      if (used !== undefined) {
        state.contextTokens = used;
        emit({ type: 'usage', inputTokens: 0, outputTokens: 0, contextTokens: used });
      }
      break;
    }
    // user_message_chunk (history), available_commands_update, current_mode_update and
    // config_option_update (process.ts keeps the session's options) carry nothing for the turn.
  }
}

/** The files an own tool call names (its locations and path keys). */
function pathsOf(toolCall: Record<string, unknown>, raw: Record<string, unknown>): string[] {
  const out = (Array.isArray(toolCall.locations) ? toolCall.locations : []).flatMap((loc) => (isRecord(loc) && typeof loc.path === 'string' ? [loc.path] : []));
  for (const key of ['path', 'file_path', 'abs_path']) if (typeof raw[key] === 'string' && !out.includes(raw[key] as string)) out.push(raw[key] as string);
  return out.slice(0, 50);
}

/** The answer to a permission request: allow_once (else allow_always), or reject_once (else reject_always). */
export function permissionOutcome(options: unknown[], decision: 'allow' | 'deny' | 'cancel'): Record<string, unknown> {
  if (decision === 'cancel') return { outcome: { outcome: 'cancelled' } };
  const list = options.filter(isRecord);
  const pick = (kinds: string[]) => {
    for (const kind of kinds) {
      const option = list.find((o) => o.kind === kind && typeof o.optionId === 'string');
      if (option) return option.optionId as string;
    }
    return undefined;
  };
  const optionId = decision === 'allow' ? pick(['allow_once', 'allow_always']) : pick(['reject_once', 'reject_always']);
  return optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } };
}

/** A prompt's stopReason as the turn's stop. */
export function stopFor(stopReason: unknown): { stop: EngineTurnResult['stop']; error?: WorkforceErrorData } {
  switch (stopReason) {
    case 'end_turn': return { stop: 'done' };
    case 'cancelled': return { stop: 'interrupted', error: ERR.cancelled() };
    case 'max_tokens': return { stop: 'error', error: ERR.failed('The answer reached the length limit.') };
    case 'max_turn_requests': return { stop: 'error', error: ERR.failed('The agent reached its step limit for one turn.') };
    case 'refusal': return { stop: 'error', error: ERR.failed('The agent refused this request.') };
    default: return { stop: 'error', error: ERR.failed() };
  }
}

/** Token usage of a prompt answer (`usage`), when the agent reports it. */
export function promptUsage(result: unknown): { inputTokens: number; outputTokens: number } | undefined {
  const usage = isRecord(result) && isRecord(result.usage) ? result.usage : undefined;
  if (!usage) return undefined;
  const inputTokens = num(usage.inputTokens) ?? 0;
  const outputTokens = (num(usage.outputTokens) ?? 0) + (num(usage.thoughtTokens) ?? 0);
  return inputTokens || outputTokens ? { inputTokens, outputTokens } : undefined;
}
