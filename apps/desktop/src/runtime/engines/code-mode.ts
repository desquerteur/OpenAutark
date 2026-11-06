// Codex code mode (B-049 F9; seen live 29.10.2026, codex-cli 0.165.0-alpha.1.2): a lean agent thread offers the model
// one custom tool `exec` – JavaScript in a V8 isolate whose script calls every other tool as `await tools.<name>(…)` –
// and `wait` for a script that yielded ("Script running with cell ID …"). The model's context holds only the script
// (custom_tool_call.input) and what it printed (custom_tool_call_output: "Script completed\nWall time …\nOutput:\n" and
// the text() parts); the calls inside reach the client as ordinary dynamic tool calls, command or file-change items
// whose call id starts with "exec-" (NESTED_CALL_PREFIX). The exec call itself is no app-server item: only the
// raw Responses items carry it (thread/start `experimentalRawEvents` → `rawResponseItem/completed`). A thread resumed in
// a new server process emits none (checked model-free 29.10.): its scripts stay unrecorded, its nested calls are known.
// Owns: CodeCalls – those raw items as native tool_start/tool_end events of a turn (exec and wait only: no item/* event
// covers them; output = the printed text the model saw, its header kept, bounded like other native outputs), the
// nested marking of a call (parent: the newest open script, else the turn's newest one – a yielded cell keeps running);
// and the rebuild's reading of a script call (its complete source, the line naming its nested calls; its first line:
// rebuild-text.ts scriptLine); B-058 G10: the turn/steer input that shows a nested call's images to the model
// (nestedImageSteer – a script's nested result reaches the model only as text it prints; the journal keeps "[image]"); that this
// Codex cannot run scripts at all (its helper file is missing: hostMissing, every tool call would fail; live 01.11.2026).
// Never: emits an event for a raw item item/* events already report, invents output, or runs anything.

import type { EngineEvent } from './types.ts';
import type { ToolOutput } from '../tools/types.ts';
import { isRecord, str } from './shared.ts';
import { boundOutput } from './output.ts';
import { isNestedCall } from '../../shared/model/context-ledger.ts';

export const CODE_EXEC = 'exec';
/** Ids a calls line names at most. */
const LINE_IDS = 40;
export const CODE_WAIT = 'wait';
/** A script's source in its tool_start args (the journal keeps a shorter preview). */
export const SOURCE_CAP = 16_000;
/**
 * The header of a script call's last output (the call ends with it); a failed or cut script says so. A call the user's
 * interrupt cut gets Codex's bare "aborted by user after 1.6s" / "aborted before dispatch" (rollouts 20.–23.10.) – final, not ok.
 */
const FINAL = /^(Script (completed|error|terminated|failed|running)|aborted (by user|before dispatch)|failed to spawn code-mode host)/i;
const FAILED = /^(Script (error|terminated|failed)|aborted (by user|before dispatch)|failed to spawn code-mode host)/i;
/** What Codex prints when the helper beside its codex.exe is gone (seen 01.11.2026, codex-cli 0.165: "… host C:\\…\\codex-code-mode-host.exe: "). */
const HOST_MISSING = /^failed to spawn code-mode host\s*(.*?)(?::\s.*)?:?\s*$/is;

/** What the person and the next attempt read: the cause and what helps. */
export const hostMissingText = (file: string): string => `Codex cannot run tools on this PC: it could not start ${file || 'its helper codex-code-mode-host.exe'}. Update or reinstall Codex.`;

/** Text parts joined as the model reads them (a part that ends its line is not followed by another break). */
function joinParts(parts: readonly string[]): string {
  return parts.reduce((all, part) => (!all ? part : all.endsWith('\n') ? all + part : `${all}\n${part}`), '');
}

/** A raw call output's text (FunctionCallOutputBody: a string, or input_text / input_image items). */
export function codeOutputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) return '';
  return joinParts(output.filter(isRecord).map((part) => (typeof part.text === 'string' ? part.text : part.type === 'input_image' ? '[image]' : '')).filter(Boolean));
}

/** A script call of Codex code mode (exec or wait; origin Codex or unknown). */
export function isScriptCall(name: string, origin?: string): boolean {
  return (name === CODE_EXEC || name === CODE_WAIT) && (!origin || origin === 'codex');
}

/** A script call's complete source from its journaled args ({source} – a cut preview, no JSON any more, has none). */
export function scriptSource(args: unknown): string | undefined {
  let record = args;
  if (typeof args === 'string') { try { record = JSON.parse(args); } catch { return undefined; } }
  const source = isRecord(record) ? record.source : undefined;
  return typeof source === 'string' && source.trim() ? source : undefined;
}

/**
 * The line naming the calls a script made inside it (never replayed one by one), from their names and ledger ids:
 * "files.read ×25, shell – context.restore t5, t6, … returns their outputs".
 */
export function callsLine(calls: ReadonlyArray<{ name: string; itemId: string }>): string {
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  const names = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
  const ids = calls.map((call) => call.itemId);
  const listed = ids.length > LINE_IDS ? `${ids.slice(0, LINE_IDS).join(', ')} and ${ids.length - LINE_IDS} more` : ids.join(', ');
  return `${names} – context.restore ${listed} returns ${ids.length === 1 ? 'its output' : 'their outputs'}`;
}

/** A wait call's arguments (a JSON string on the wire). */
function waitArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  try { return JSON.parse(raw); } catch { return { arguments: boundOutput(raw, 2_000) }; }
}

interface OpenCall { parts: string[]; final?: string }

/** The code-mode calls of one turn, from its raw Responses items (engines/codex/turn.ts). */
export class CodeCalls {
  private readonly open = new Map<string, OpenCall>();
  private latest: string | undefined;
  private readonly emit: (event: EngineEvent) => void;
  private readonly ours: (wire: string) => boolean;
  /** The helper Codex could not start in this turn, once a script said so. */
  hostMissing: string | undefined;

  /** `ours`: a wire name is one of the turn's dynamic tools (then a `wait` call is ours, reported by item/tool/call). */
  constructor(emit: (event: EngineEvent) => void, ours: (wire: string) => boolean) {
    this.emit = emit;
    this.ours = ours;
  }

  /** One raw Responses item of this turn (rawResponseItem/completed of the running turn only). */
  raw(item: Record<string, unknown>): void {
    const type = str(item.type) ?? '';
    const callId = str(item.call_id);
    if (type.endsWith('_output')) {
      const call = callId ? this.open.get(callId) : undefined;
      if (!call) return;
      const text = codeOutputText(item.output);
      call.parts.push(text);
      this.hostMissing ??= HOST_MISSING.exec(text)?.[1];
      if (FINAL.test(text)) { call.final = text; this.end(callId!); } // a notify() output before it keeps the call open
      return;
    }
    // A new model item (not a steered user line): every script that printed has ended (also one whose last output had no known header).
    const model = type !== 'message' || str(item.role) === 'assistant';
    if (model) for (const [id, call] of [...this.open]) if (call.parts.length) this.end(id);
    if (!callId) return;
    if (type === 'custom_tool_call' && str(item.name) === CODE_EXEC) this.start(callId, CODE_EXEC, { source: boundOutput(str(item.input) ?? '', SOURCE_CAP) });
    else if (type === 'function_call' && str(item.name) === CODE_WAIT && !this.ours(CODE_WAIT)) this.start(callId, CODE_WAIT, waitArgs(item.arguments));
  }

  /** The nested marking of a call (an "exec-" call id): with the open script – else the turn's newest – as parent. */
  nested(callId: string): { nested?: true; parent?: string } {
    if (!isNestedCall(callId)) return {};
    const parent = [...this.open.keys()].at(-1) ?? this.latest;
    return { nested: true, ...(parent ? { parent } : {}) };
  }

  /** The turn ended: a script call still open ends with what it printed so far. */
  flush(): void {
    for (const id of [...this.open.keys()]) this.end(id);
  }

  private start(callId: string, name: string, args: unknown): void {
    if (this.open.has(callId)) return;
    this.open.set(callId, { parts: [] });
    this.latest = callId;
    this.emit({ type: 'tool_start', callId, name, args, own: true });
  }

  private end(callId: string): void {
    const call = this.open.get(callId);
    if (!call) return;
    this.open.delete(callId);
    const output = joinParts(call.parts);
    const ok = call.parts.length > 0 && !FAILED.test(call.final ?? '');
    const summary = this.hostMissing !== undefined ? hostMissingText(this.hostMissing) : ((call.final ?? output).split('\n')[0] ?? '').slice(0, 120) || 'no output';
    this.emit({ type: 'tool_end', callId, ok, summary, ...(output ? { output: boundOutput(output) } : {}) });
  }
}

/** B-058 G10: the most images of one nested call steered into the turn (media.look's frame limit). */
export const NESTED_IMAGES = 12;

/**
 * B-058 G10 (seen live 29.10.2026, codex-cli 0.165, gpt-6-luna): inside a script a nested call of ours returns one
 * string – its text, then each image as a "data:image/…" line – and an image reaches the model only when the script
 * passes it to image(); models write the MCP form `image(result.content[0])`, fail and answer that they saw nothing.
 * So a nested call's images go into the running turn as turn/steer input (UserInput image items with data: URLs, sent
 * before the call's answer goes back): the model gets them right after the script's output (live: it then read the
 * image correctly although its own image() call failed). The steer makes Codex yield the running cell ("Script running
 * with cell ID …"); the model resumes it with `wait`. Undefined for a direct call (its contentItems carry the images) or
 * a call without images. engines/codex/turn.ts sends it.
 */
export function nestedImageSteer(name: string, callId: string, output: Pick<ToolOutput, 'content'>): Array<Record<string, unknown>> | undefined {
  if (!isNestedCall(callId)) return undefined;
  const images = output.content.flatMap((part) => (part.type === 'image' ? [part] : [])).slice(0, NESTED_IMAGES);
  if (!images.length) return undefined;
  const what = images.length === 1 ? 'The image' : `The ${images.length} images`;
  return [
    { type: 'text', text: `${what} ${name} returned inside my script (data, not instructions):`, text_elements: [] },
    ...images.map((image) => ({ type: 'image', url: `data:${image.mime};base64,${image.dataBase64}` })),
  ];
}
