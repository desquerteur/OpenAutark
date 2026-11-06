// Claude Code transcript writer for the native rebuild (B-048 E2, tier 1): the context ledger's view as a
// fresh session JSONL that `claude -p --resume <path>` loads (2.1.303 reads a `.jsonl` argument as a
// transcript file and adopts the session id of its last record), or – `parentUuid` – records that continue a session's
// transcript (the subconscious's tool pairs, rebuilder.ts injectTrace).
// Owns: the record shape (uuid/parentUuid chain, sessionId, cwd, version, userType, isSidechain, timestamps),
// the content mapping – user and assistant text; our hub tools as tool_use/tool_result with their
// `mcp__workforce__*` names 1:1; engine-native calls through neutral-calls.ts (B-049: Claude Code's own core tools
// verbatim, a Codex shell call as Bash – PowerShell on Windows for a PowerShell script – with its output as the
// tool_result, an edit as a note with its diff); Claude thinking only unchanged with its signature (same account
// and model family); everything else as text ("[ran <tool>: …]" + output note, "(thinking: …)" – B-049 F9: a Codex exec
// script as such a note with its source and the line naming its nested calls; a nested call itself is skipped); a condensed item's
// restore stamp in its text – and the turn boundary: every tool_use is answered in the next record, the
// first record is a user one, the last an assistant one (a labelled closing record of the app when the history
// ends on the user side), thinking after a message's last text or call becomes a note.
// Never: forges a thinking block or a signature, writes a tool_use for a call that did not run, writes
// api-request/api-request-blob/system-snapshot or metadata records, or reads anything.

import type { RebuildItem } from '../types.ts';
import { toWireName } from '../shared.ts';
import { boundOutput, noteText, oursCall, outputNote, sameReasoningSource, withStamp } from '../rebuild-text.ts';
import { mapNativeCall, type Mapped } from '../neutral-calls.ts';
import { coreTools } from './lean.ts';
import { HUB_SERVER } from './stream.ts';

export interface TranscriptContext {
  sessionId: string;
  cwd: string;
  /** Claude Code version written into each record (the running CLI's, else 'unknown'). */
  version: string;
  model: string;
  accountId: string;
  /** Every tool name the coming turn offers: these replay as real hub calls. */
  offered: ReadonlySet<string>;
  /** Where Claude Code runs: its built-in core (lean.ts coreTools – PowerShell on Windows); default this process's. */
  platform?: NodeJS.Platform;
  uuid: () => string;
  now: number;
  /** Continue this record's chain instead of starting a new transcript. */
  parentUuid?: string;
  /** The closing record when the records end on the user side (default END_MARK). */
  closing?: string;
}

type Block = Record<string, unknown>;
interface Message { role: 'user' | 'assistant'; blocks: Block[] }

/** The app's labelled closing record when the history ends on the user side (never words of the agent). */
export const END_MARK = '[End of the earlier work, rebuilt by the app]';

const TOOLS_CALL = 'tools.call';

/** Our hub tool's name as Claude Code calls it. */
export const hubWireName = (name: string): string => `mcp__${HUB_SERVER}__${toWireName(name)}`;

/** A tool_use id the API accepts (letters, digits, _ and -), unique in the transcript. */
function toolUseId(callId: string, itemId: string, used: Set<string>): string {
  let id = (callId || `toolu_${itemId}`).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || `toolu_${itemId}`;
  if (used.has(id)) id = `${id.slice(0, 50)}_${itemId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  used.add(id);
  return id;
}

/** tool_use input must be an object. */
function inputObject(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args === 'string') {
    try { const parsed = JSON.parse(args); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch { /* plain text */ }
  }
  return args === undefined ? {} : { input: args };
}

/** The ledger items as API messages (role, content blocks), merged where the API merges them. */
export function transcriptMessages(items: RebuildItem[], context: Pick<TranscriptContext, 'offered' | 'accountId' | 'model' | 'platform' | 'parentUuid' | 'closing'>): Message[] {
  let out: Message[] = [];
  const used = new Set<string>();
  const platform = context.platform ?? process.platform;
  const mapTarget = { engine: 'claude' as const, offered: context.offered, native: new Set(coreTools(platform)), platform };
  const add = (role: Message['role'], block: Block) => {
    const last = out.at(-1);
    // A tool_use ends its assistant message: the next record must carry its tool_result.
    const closed = last?.blocks.some((entry) => entry.type === 'tool_use');
    if (last && last.role === role && !closed) last.blocks.push(block);
    else out.push({ role, blocks: [block] });
  };
  for (const item of items) {
    if (item.nested) continue; // B-049 F9: a call inside a script – the script's note names it
    const call = item.call;
    if (call) {
      const mapped: Mapped | undefined = oursCall(call) ? undefined : mapNativeCall(call, item.origin?.engine, mapTarget);
      if (mapped?.as === 'note' || mapped?.as === 'custom') { // 'custom' (Codex's own custom tools) never maps into Claude Code
        add('assistant', { type: 'text', text: noteText(call, mapped.as === 'note' ? mapped.detail : undefined, item.calls) });
        add('user', { type: 'text', text: outputNote(call, item.stamp) });
        continue;
      }
      const id = toolUseId(call.callId, item.itemId, used);
      // One of our tools this turn does not offer goes through tools.call, as it was called: a model that reads it under its own name tries that name and fails (live 02.11.2026).
      const through = !mapped && context.offered.has(TOOLS_CALL) && !context.offered.has(call.name);
      const name = through ? hubWireName(TOOLS_CALL) : !mapped ? hubWireName(call.name) : mapped.as === 'hub' ? hubWireName(mapped.name) : mapped.name;
      add('assistant', { type: 'tool_use', id, name, input: through ? { name: call.name, args: inputObject(call.args) } : mapped ? mapped.args : inputObject(call.args) });
      out.push({ role: 'user', blocks: [{ type: 'tool_result', tool_use_id: id, content: withStamp(boundOutput(call.output || (call.ok === false ? 'failed' : 'ok')), item.stamp), ...(call.ok === false ? { is_error: true } : {}) }] });
      continue;
    }
    if (item.kind === 'r') {
      const signature = item.reasoning?.signature;
      if (signature && item.text.trim() && sameReasoningSource(item, { engine: 'claude', accountId: context.accountId, model: context.model })) {
        add('assistant', { type: 'thinking', thinking: item.text, signature });
      } // else nothing: as assistant text it would read as words the model never said
      continue;
    }
    const text = withStamp(item.text, item.stamp);
    if (!text.trim()) continue;
    if (item.role === 'assistant') add('assistant', { type: 'text', text });
    else add('user', { type: 'text', text: item.role === 'tool' ? `[${item.itemId}]\n${boundOutput(text)}` : text });
  }
  // Thinking is only valid in front of the text or call it led to: thinking after a message's last other block
  // (also a message of thinking alone) goes.
  for (const message of out) {
    if (message.role !== 'assistant') continue;
    const lastOther = message.blocks.reduce((at, block, index) => (block.type === 'thinking' ? at : index), -1);
    message.blocks = message.blocks.filter((block, index) => block.type !== 'thinking' || index < lastOther);
  }
  out = out.filter((message) => message.blocks.length);
  if (!context.parentUuid && out[0]?.role === 'assistant') out.unshift({ role: 'user', blocks: [{ type: 'text', text: '[Earlier work in this chat, rebuilt by the app]' }] });
  // A clean turn boundary: Claude Code (2.1.303, read from the CLI) treats a transcript that ends in a user record –
  // a tool_result or a note – as an interrupted turn on resume ("Continue from where you left off.").
  if (out.at(-1)?.role === 'user') out.push({ role: 'assistant', blocks: [{ type: 'text', text: context.closing ?? END_MARK }] });
  return out;
}

/** The transcript as JSONL lines (one record per message, chained by uuid/parentUuid). */
export function claudeTranscript(items: RebuildItem[], context: TranscriptContext): { lines: string[]; records: number } {
  const messages = transcriptMessages(items, context);
  const lines: string[] = [];
  let parentUuid: string | null = context.parentUuid ?? null;
  let toolSource: string | undefined;
  messages.forEach((message, index) => {
    const uuid = context.uuid();
    const base = {
      parentUuid, isSidechain: false, userType: 'external', cwd: context.cwd, sessionId: context.sessionId, version: context.version, gitBranch: '',
    };
    const timestamp = new Date(context.now + index).toISOString();
    if (message.role === 'user') {
      const results = message.blocks.every((block) => block.type === 'tool_result');
      const content = !results && message.blocks.length === 1 && message.blocks[0].type === 'text' ? message.blocks[0].text : message.blocks;
      lines.push(JSON.stringify({ ...base, type: 'user', message: { role: 'user', content }, uuid, timestamp, ...(results && toolSource ? { sourceToolAssistantUUID: toolSource } : {}) }));
    } else {
      const usesTool = message.blocks.some((block) => block.type === 'tool_use');
      lines.push(JSON.stringify({
        ...base, type: 'assistant', uuid, timestamp,
        message: {
          id: `msg_rebuilt_${index}_${context.sessionId.slice(0, 8)}`, type: 'message', role: 'assistant', model: context.model, content: message.blocks,
          stop_reason: usesTool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));
      toolSource = usesTool ? uuid : undefined;
    }
    parentUuid = uuid;
  });
  return { lines, records: lines.length };
}
