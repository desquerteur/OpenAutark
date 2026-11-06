// What an agent did on its last turn (B-076, owner 05.11.2026: asked for "den kompletten letzten Runtime-Ding", he
// expected "wo die ganzen Daten noch dazu sind … was er eben alles durchgeführt hat"): when a turn of the agent's main lane
// ends, the app writes <data>/agents/<id>/last-run.md beside last-prompt.md – the turn's input as the engine got it, every
// step of the run log (tool calls with their arguments, each result under its call, reasoning summaries, notes, errors)
// and the final text. Each piece is redacted before it is cut (a cut never splits a secret value); a long input keeps its
// start and its end (the new messages come last); when the steps would pass the file's size, the newest steps that fit
// stay and the final text always does. Overwritten each turn; never fails a turn; never creates the agent's folder.
// Owns: this file's name and text form. Never: reads it back or lets it influence a prompt.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RunItem } from '../../shared/model/runs.ts';
import { agentFolder, isCoreFolderName } from '../agent-core/layout.ts';
import { fullOutput } from '../runs/journal.ts';

export const LAST_RUN_FILE = 'last-run.md';
/** The whole file stays readable: a step is cut at STEP_MAX, the input and the final text at their own size, the steps share what is left of FILE_MAX. */
const STEP_MAX = 2000;
const INPUT_MAX = 20_000;
const FINAL_MAX = 40_000;
const FILE_MAX = 200_000;

export interface LastRun {
  runId: string;
  trigger?: string;
  model?: string;
  effort?: string;
  status?: string;
  endedAt: number;
  /** The turn's input text as the engine got it (its text parts joined). */
  input: string;
  items: readonly RunItem[];
  finalText?: string;
}

type Redact = (text: string) => string;

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}\n… (cut: ${text.length - max} more characters)` : text);
/** Keeps a quarter from the start and the rest from the end: an input's new messages come last. */
const cutMiddle = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const head = Math.floor(max / 4);
  return `${text.slice(0, head)}\n… (cut: ${text.length - max} characters) …\n${text.slice(text.length - (max - head))}`;
};
const str = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value));
const indent = (text: string, by: string): string => text.replace(/\n/g, `\n${by}`);

/** A result's text: the engine's own tools keep their output beside a status word ("exit 0"), ours a preview and the text parts. */
function resultText(d: Record<string, unknown>): string {
  const full = fullOutput(d);
  if (!full) return str(d.preview ?? d.summary);
  return typeof d.output === 'string' && typeof d.summary === 'string' && d.summary && !full.startsWith(d.summary) ? `${d.summary}\n${full}` : full;
}

/** One run-log item as a readable step; every piece redacted before it is cut. */
function step(item: RunItem, redact: Redact): string {
  const d = item.data ?? {};
  const part = (value: unknown) => cut(redact(str(value)), STEP_MAX);
  switch (item.kind) {
    case 'tool_call': return `- **Call ${item.name || str(d.name) || 'tool'}**${d.summary ? ` – ${redact(str(d.summary))}` : ''}\n  \`\`\`\n  ${indent(part(d.args), '  ')}\n  \`\`\``;
    case 'tool_result': return `  → ${d.ok === false ? 'failed' : 'result'}: ${indent(part(resultText(d)), '    ')}`;
    case 'reasoning': return `- _Thinking:_ ${part(d.summary ?? d.text)}`;
    case 'error': return `- **Error:** ${part(d.message ?? d.error ?? d.text ?? d)}`;
    default: return `- ${item.kind}: ${part(d.text ?? d.summary ?? d)}`;
  }
}

/** The steps in run order, each result right under its call (parallel calls journal call, call, result, result). */
function steps(items: readonly RunItem[], redact: Redact): string[] {
  const sorted = [...items]
    .filter((item) => !(item.kind === 'note' && item.data?.answer === true)) // the final text stands once, below
    .sort((a, b) => a.seq - b.seq);
  const callIdOf = (item: RunItem) => (typeof item.data?.callId === 'string' ? item.data.callId : undefined);
  const results = new Map<string, RunItem>();
  for (const item of sorted) { const id = callIdOf(item); if (item.kind === 'tool_result' && id && !results.has(id)) results.set(id, item); }
  const calls = new Set(sorted.filter((item) => item.kind === 'tool_call').map(callIdOf).filter(Boolean));
  const out: string[] = [];
  for (const item of sorted) {
    const id = callIdOf(item);
    if (item.kind === 'tool_result' && id && calls.has(id) && results.get(id) === item) continue; // placed under its call
    out.push(step(item, redact));
    const result = item.kind === 'tool_call' && id ? results.get(id) : undefined;
    if (result) out.push(step(result, redact));
  }
  return out;
}

/** The file's text: what it is, the turn's facts, its input, its steps in order, its final text. */
export function lastRunText(run: LastRun, redact: Redact = (text) => text): string {
  const facts = [run.trigger, run.model, run.effort && `effort ${run.effort}`, run.status, new Date(run.endedAt).toISOString()].filter(Boolean).join(' · ');
  const all = steps(run.items, redact);
  const head = [
    '<!-- What I did on my last turn, written by the app when the turn ended (secrets replaced by their handles, long parts cut); editing it changes nothing. The system prompt of that turn is last-prompt.md beside it; earlier turns: Team › Runs. -->',
    '',
    `# Last turn – ${run.runId}`,
    facts,
    '',
    '## What came in',
    cutMiddle(redact(run.input.trim()) || '(no text)', INPUT_MAX),
    '',
    `## What I did (${all.length} step${all.length === 1 ? '' : 's'})`,
  ].join('\n');
  const tail = ['', '## My final text', cut(redact(run.finalText?.trim() ?? '') || '(none)', FINAL_MAX), ''].join('\n');
  // The newest steps that fit stay, whole; the ones before them are named by their count.
  let budget = FILE_MAX - head.length - tail.length - 200;
  let first = all.length;
  while (first > 0 && all[first - 1]!.length + 1 <= budget) { budget -= all[first - 1]!.length + 1; first -= 1; }
  const kept = all.slice(first);
  const body = all.length
    ? [...(first ? [`… (${first} earlier step${first === 1 ? '' : 's'} left out – Team › Runs has them)`] : []), ...kept].join('\n')
    : '(no tool calls)';
  return `${head}\n${body}\n${tail}`;
}

/** Writes the file when the agent has its folder; `redact` replaces secret values; any failure is only a debug line. */
export function writeLastRun(dataDir: string | undefined, agentId: string, run: LastRun, redact: Redact = (text) => text, debug?: (message: string, data: Record<string, unknown>) => void): void {
  if (!dataDir || !isCoreFolderName(agentId)) return;
  try {
    writeFileSync(path.join(agentFolder(dataDir, agentId), LAST_RUN_FILE), redact(lastRunText(run, redact)), 'utf8');
  } catch (error) {
    debug?.('last run not written', { agentId, error: String(error) });
  }
}
