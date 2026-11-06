// Fake engine for tests and demos (no network, no processes).
// Rules applied to the turn's new input (see below), in order:
//   `[[tool:<name> {json}]]` → calls our tool `<name>` with the JSON args (several allowed),
//   `[[ui:{json}]]`          → emits a ```ui fenced block with that JSON,
//   `[[app:<attrs>|<html>]]` → (F01) emits an ```app <attrs> fence with that HTML (e.g.
//                              `[[app:title="Take" todo=true|<button>Done</button>]]`),
//   `[[limit]]`              → stops with 'limit' (retryAfterMs 60000),
//   `[[fail]]`               → stops with 'error',
//   `[[hang:<name> {json}]]` → (RC1) starts an engine-native tool `<name>` and never finishes it:
//                              the turn waits until it is stopped (or the process is killed).
//                              Like a careful model it does not start it again when the input
//                              names that tool with "verify before repeating" (a recovery note
//                              or a previous-attempt recap) – it verifies and carries on,
//   `[[size:<name> {json}]]` → (O8) calls our tool `<name>` like [[tool:…]] but tells only the
//                              size of its output: `<name> size → {"chars":…,"items":…,
//                              "truncated":…,"error":…}` (items for a JSON array; truncated when
//                              the registry moved the text into a file),
//   `[[prompt:<text>]]`      → (O8) quotes each line of the system prompt (stable, then volatile)
//                              containing <text> as "prompt → <line>", or says that none does,
//   "$task" in tool args     → (O8) the turn's current task id (the volatile prompt's
//                              "## Current task" section), so a scripted handoff can finish it,
//   `[[structured:{json}]]`  → (X08) with an output schema, that JSON is the structured answer
//                              (unparsable JSON: { ok: true }, the answer of every other schema
//                              turn), e.g. a scripted helper answer,
//   otherwise                → echoes "Echo: <new input>" (as written: no history escapes).
// Steering (17:09): steer() takes text only while that run is in progress (not for script turns);
// before the answer it is new input like the rest – its [[tool:…]] directives run, the rest is echoed
// ("Echo: <steered text>"); a turn that ends otherwise (stopped) leaves it to the next turn.
// New input (INT-8): directives never come from history – not from a full projection's summary
// and earlier lines (context/projection.ts), not from the agent's own messages, and not from
// lines its native session already received (Received below). "verify before repeating" is read
// from the whole input.
// A custom `script` replaces the rules entirely.
// Models (RT10, fakeModels): 'fake-1', or the provider model ids in WORKFORCE_FAKE_MODELS
// ("gpt-6.1-sol,claude-opus-5-5") – listed bare, so the catalog merges them with the priors like
// a real listing (routing E2E tests see real tiers, efforts and strengths).
// Owns: the scripted rules above, what counts as new input and the fake model list.
// Never: used for real work (registry exposes it only when enabled).

import type { Account, EngineId } from '../../shared/model/providers.ts';
import type { AccountCheck, Engine, EngineCaps, EngineEvent, EngineModel, EngineTurnInput, EngineTurnResult } from './types.ts';
import { outputText } from './shared.ts';
import { HELD, OWN_LABEL, withoutHistory } from '../context/projection.ts';
import { fakeFork } from './fake-fork.ts'; // B-057: fork() records its inputs (fork.calls) and answers fake-fork-<n>

export type FakeScript = (input: EngineTurnInput) => Promise<EngineTurnResult> | EngineTurnResult;

const TOOL = /\[\[tool:([a-zA-Z0-9_.-]+)\s*(\{[\s\S]*?\})?\]\]/g;
const UI = /\[\[ui:(\{[\s\S]*?\})\]\]/g;
const STRUCTURED = /\[\[structured:(\{[\s\S]*?\})\]\]/;
const HANG = /\[\[hang:([a-zA-Z0-9_.-]+)\s*(\{[\s\S]*?\})?\]\]/;
const APP = /\[\[app:([^|\]\n]*)\|([\s\S]*?)\]\]/g;
const NOTHING_NEW = '(no new input)';
/** The echo says what was written: context/render.ts neutralize()'s "\" before quoted chat lines comes off again. */
const echoText = (text: string): string => text.replace(/^(\s*)\\(?=\[[^\]\n]{1,40}\]\s|·\s)/gm, '$1');

/** Tool names the input says to verify before repeating ("- 14:02 bash: … verify before repeating"). */
function toVerify(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const match = /^- \S+ ([a-zA-Z0-9_.-]+):.*verify before repeating/.exec(line.trim());
    if (match) names.add(match[1]);
  }
  return names;
}

export class FakeEngine implements Engine {
  readonly id: EngineId = 'fake';
  readonly caps: EngineCaps = { sessions: true, dynamicTools: true, mcp: false, images: false, rebase: true, structured: true, ownTools: false, fork: true };
  readonly fork = fakeFork();
  private readonly script?: FakeScript;
  private sessions = 0;
  private readonly received = new Received();
  private readonly steering = new Map<string, string[]>(); // runId → steered text of a running turn
  readonly turns: EngineTurnInput[] = []; // for assertions

  constructor(options: { script?: FakeScript } = {}) {
    this.script = options.script;
  }

  async listModels(): Promise<EngineModel[]> {
    return fakeModels(process.env.WORKFORCE_FAKE_MODELS);
  }

  async checkAccount(_account: Account): Promise<AccountCheck> {
    return { state: 'ok', plan: 'test' };
  }

  /** 17:09: text steered into a running turn – taken only while that turn runs, answered in it ("Echo: …"). */
  async steer(runId: string, text: string): Promise<boolean> {
    const queue = this.steering.get(runId);
    if (!queue) return false;
    queue.push(text);
    return true;
  }

  async run(input: EngineTurnInput): Promise<EngineTurnResult> {
    this.turns.push(input);
    if (this.script) return this.script(input);
    this.steering.set(input.runId, []);
    try { return await this.turn(input); } finally { this.steering.delete(input.runId); }
  }

  private async turn(input: EngineTurnInput): Promise<EngineTurnResult> {
    const emit = (event: EngineEvent) => { try { input.onEvent(event); } catch { /* isolate */ } };
    const session = input.session ?? { ref: `fake-session-${++this.sessions}`, generation: 1 };
    const text = input.input.filter((i) => i.type === 'text').map((i) => (i as { text: string }).text).join('\n');
    const key = `${input.agentId}\n${session.ref}`;
    const { fresh, held } = this.received.read(key, text);
    const stopped = (): EngineTurnResult => {
      if (!cutOff(input.signal)) this.received.add(key, fresh);
      return { text: '', stop: 'interrupted', session };
    };
    if (input.signal.aborted) return stopped();
    if (fresh.includes('[[limit]]')) return { text: '', stop: 'limit', session, error: { code: 'rate_limited', message: 'The usage limit of this account was reached.', retryAfterMs: 60_000 } };
    if (fresh.includes('[[fail]]')) return { text: '', stop: 'error', session, error: { code: 'internal', message: 'The model could not complete this turn.' } };
    const parts: string[] = [];
    const hang = input.outputSchema ? null : HANG.exec(fresh); // a helper turn reads the person's words as data: they are no script for it
    if (hang && toVerify(text).has(hang[1])) parts.push(`${hang[1]} not started again: its effect is unknown, so I verify first.`);
    else if (hang) {
      let args: unknown = {};
      try { args = hang[2] ? JSON.parse(hang[2]) : {}; } catch { args = {}; }
      emit({ type: 'tool_start', callId: 'fake_hang_1', name: hang[1], args, own: true });
      await new Promise<void>((resolve) => { if (input.signal.aborted) resolve(); else input.signal.addEventListener('abort', () => resolve(), { once: true }); });
      return stopped();
    }
    let n = 0;
    const tools = async (source: string) => {
      for (const match of source.matchAll(TOOL)) {
        const callId = `fake_call_${++n}`;
        let args: unknown = {};
        try { args = match[2] ? JSON.parse(withTask(match[2], input)) : {}; } catch { args = {}; }
        emit({ type: 'tool_start', callId, name: match[1], args, own: false });
        const output = await input.callTool(match[1], args, callId);
        emit({ type: 'tool_end', callId, ok: !output.isError, summary: outputText(output, 120) });
        parts.push(`${match[1]} → ${outputText(output, 2000)}`);
      }
    };
    await tools(fresh);
    parts.push(...await readings(fresh, input, emit));
    for (const match of fresh.matchAll(UI)) parts.push(`\`\`\`ui\n${match[1]}\n\`\`\``);
    for (const match of fresh.matchAll(APP)) parts.push(`\`\`\`app ${match[1].trim()}\n${match[2].trim()}\n\`\`\``);
    const rest = withoutReadings(fresh).replace(TOOL, '').replace(UI, '').replace(new RegExp(HANG.source, 'g'), '').replace(APP, '').replace(new RegExp(STRUCTURED.source, 'g'), '').trim();
    if (!parts.length || rest) parts.unshift(`Echo: ${echoText(rest || fresh) || NOTHING_NEW}`);
    if (held) this.received.add(key, fresh);
    else this.received.end(key);
    // Steered text is new input too (17:09): its tool directives run, the rest is echoed – also what arrives meanwhile.
    for (let steered = this.steering.get(input.runId)?.shift(); steered !== undefined; steered = this.steering.get(input.runId)?.shift()) {
      await tools(steered);
      const rest = steered.replace(TOOL, '').trim();
      if (rest) parts.push(`Echo: ${echoText(rest)}`);
    }
    const answer = parts.join('\n\n');
    for (const chunk of answer.match(/.{1,40}/gs) ?? []) emit({ type: 'text', delta: chunk });
    emit({ type: 'usage', inputTokens: text.length, outputTokens: answer.length });
    let structured: unknown;
    if (input.outputSchema) structured = scripted(fresh) ?? { ok: true };
    return { text: answer, stop: 'done', session, usage: { inputTokens: text.length, outputTokens: answer.length }, structured };
  }

  async dispose(): Promise<void> {}
}

/** X08: the JSON of a `[[structured:{…}]]` directive in the new input (undefined: none, or not JSON). */
function scripted(fresh: string): unknown {
  const match = STRUCTURED.exec(fresh);
  try { return match ? JSON.parse(match[1]) : undefined; } catch { return undefined; }
}

// ---- INT-8: what a fake session already received

/** Sessions with a record (the oldest go first) and lines per session. */
const RECEIVED_SESSIONS = 50;
const RECEIVED_LINES = 200;
const HELD_NOTES = Object.values(HELD);
// A chat line that starts an entry – "[11:05] Name: …", "· …" (render.ts escapes such body
// lines) – and one of the agent's own ("[11:05] Vic (me): …").
const ENTRY = /^(?:\[[^\]\n]{1,40}\] [^:\n]*: |· )/;
const OWN_ENTRY = new RegExp(`^(?:\\[[^\\]\\n]{1,40}\\] |· )[^:\\n]* ${OWN_LABEL.replace(/[()]/g, '\\$&')}: `);
/** A stamp's date: "[20 Oct 23:59] Alex: …" after midnight is the line "[23:59] Alex: …" was. */
const STAMP_DATE = /^\[[^\]\n]*?(\d{2}:\d{2})\] /;
const same = (line: string) => line.trim().replace(STAMP_DATE, '[$1] ');

/** Urgent work or a shutdown cut the turn off (dispatcher.ts names the kind): its input stays new. */
function cutOff(signal: AbortSignal): boolean {
  const kind = (signal.reason as { details?: { stopKind?: unknown } } | null | undefined)?.details?.stopKind;
  return kind === 'urgent' || kind === 'shutdown';
}

/** The lines without the agent's own messages (a full projection and a catch-up list them). */
function othersOnly(lines: string[]): string[] {
  let own = false;
  return lines.filter((line) => {
    if (ENTRY.test(line)) own = OWN_ENTRY.test(line);
    return !own;
  });
}

/**
 * Per native session (agent + session ref: one per chat), the input lines it received that the
 * runtime delivers again: the cursor stays after a stopped or failed turn (agents/turn-finish.ts)
 * and stops before a colleague's message still being written or a file still being read
 * (context/delta.ts, the HELD notes). Like a native session the model has them already – and
 * the person stopped them: after a Stop in [[hang:…]] the next message must not hang again.
 * - a stopped turn (the person's Stop, or an abort without a kind) adds its new lines;
 * - a finished turn ends the record (its cursor moved past all it got) – unless a HELD note says
 *   the cursor stopped short; then it adds its new lines too;
 * - a failed or limit turn, an urgent or shutdown interrupt add nothing: that input runs again
 *   ([[fail]] climbs the ladder, cut-off work goes on).
 * Each turn first forgets the lines it is not given again (the cursor moved past them). A new
 * session or process starts empty: a full projection's headers and RC1's verify rule decide.
 */
class Received {
  private readonly sessions = new Map<string, Set<string>>();

  /** The new input – no projection history, own lines or lines the session got – and whether the cursor stops short. */
  read(key: string, text: string): { fresh: string; held: boolean } {
    const lines = othersOnly(withoutHistory(text).split('\n'));
    const held = lines.some((line) => HELD_NOTES.some((note) => line.includes(note)));
    const seen = this.sessions.get(key);
    if (seen) {
      const given = new Set(lines.map(same));
      for (const line of seen) if (!given.has(line)) seen.delete(line);
    }
    return { fresh: lines.filter((line) => !seen?.has(same(line))).join('\n').trim(), held };
  }

  /** The session received the lines of `fresh`. */
  add(key: string, fresh: string): void {
    const seen = this.sessions.get(key) ?? new Set<string>();
    for (const line of fresh.split('\n')) if (line.trim()) seen.add(same(line));
    for (const line of seen) { if (seen.size <= RECEIVED_LINES) break; seen.delete(line); }
    this.sessions.delete(key); // the newest last
    if (seen.size) this.sessions.set(key, seen);
    for (const old of this.sessions.keys()) { if (this.sessions.size <= RECEIVED_SESSIONS) break; this.sessions.delete(old); }
  }

  /** The session's cursor moved past all it received. */
  end(key: string): void {
    this.sessions.delete(key);
  }
}

// ---- RT10: the listed models

/** The default fake model, with the efforts of the fake harness. */
const FAKE_1: EngineModel = { model: 'fake-1', name: 'Fake model', efforts: ['none', 'low', 'medium', 'high'], defaultEffort: 'medium' };
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/;
const MAX_MODELS = 20;

/**
 * The models of a WORKFORCE_FAKE_MODELS value: comma-separated provider model ids, trimmed,
 * deduplicated, at most 20; ids with other characters are skipped. Each is listed bare – its id
 * as name, no efforts, no window – so the catalog takes name, efforts and default effort from the
 * priors; 'fake-1' keeps its own entry. Unset, empty or nothing valid: fake-1 alone.
 */
export function fakeModels(value: string | undefined): EngineModel[] {
  const ids = [...new Set((value ?? '').split(',').map((id) => id.trim()).filter((id) => MODEL_ID.test(id)))].slice(0, MAX_MODELS);
  if (!ids.length) return [{ ...FAKE_1, efforts: [...FAKE_1.efforts] }];
  return ids.map((id) => (id === FAKE_1.model ? { ...FAKE_1, efforts: [...FAKE_1.efforts] } : { model: id, name: id, efforts: [] }));
}

// ---- O8: what an agent is told, how big a tool output is, and the turn's task (org E2E)

const SIZE = /\[\[size:([a-zA-Z0-9_.-]+)\s*(\{[\s\S]*?\})?\]\]/g;
const PROMPT = /\[\[prompt:([^\]\n]+)\]\]/g;
const CURRENT_TASK = /(?:^|\n)## Current task\n(\S+)/;

/** `"$task"` (a whole JSON string) → the turn's current task id; unchanged when the turn has none. */
function withTask(raw: string, input: EngineTurnInput): string {
  const id = CURRENT_TASK.exec(input.system?.volatile ?? '')?.[1];
  return id ? raw.split('"$task"').join(JSON.stringify(id)) : raw;
}

/** The answer parts of `[[size:…]]` (the tool really runs; only its output size is told) and `[[prompt:…]]`. */
async function readings(text: string, input: EngineTurnInput, emit: (event: EngineEvent) => void): Promise<string[]> {
  const parts: string[] = [];
  let n = 0;
  for (const match of text.matchAll(SIZE)) {
    const callId = `fake_size_${++n}`;
    let args: unknown = {};
    try { args = match[2] ? JSON.parse(withTask(match[2], input)) : {}; } catch { args = {}; }
    emit({ type: 'tool_start', callId, name: match[1], args, own: false });
    const output = await input.callTool(match[1], args, callId);
    emit({ type: 'tool_end', callId, ok: !output.isError, summary: outputText(output, 120) });
    const full = outputText(output);
    let items: number | undefined;
    try { const value: unknown = JSON.parse(full); if (Array.isArray(value)) items = value.length; } catch { /* not JSON */ }
    parts.push(`${match[1]} size → ${JSON.stringify({ chars: full.length, items, truncated: full.includes('[output truncated'), error: output.isError === true })}`);
  }
  const lines = `${input.system?.stable ?? ''}\n${input.system?.volatile ?? ''}`.split('\n');
  for (const match of text.matchAll(PROMPT)) {
    const needle = match[1].trim();
    const found = needle ? lines.filter((line) => line.includes(needle)) : [];
    parts.push(found.length ? found.map((line) => `prompt → ${line}`).join('\n') : `prompt → (no line with "${needle}")`);
  }
  return parts;
}

/** The text without `[[size:…]]` and `[[prompt:…]]` (for the echo). */
function withoutReadings(text: string): string {
  return text.replace(SIZE, '').replace(PROMPT, '');
}
