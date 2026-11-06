// Shared text rules of the native rebuild for Codex and Claude Code: how a ledger item that has
// no native counterpart in the target CLI reads as text, and the bound of a native tool's output.
// Owns: the "[ran <tool>: <summary>]" note (with its detail and – B-049 F9 – a script's nested-calls line, noteText)
// and its user-side output note, a code-mode script's first line,
// the condensed item's restore stamp at the end of its text, model families (reasoning replays only within
// one), and how a failed first turn on a
// rebuilt session is reported (an ended session, so the executor falls back).
// Never: invents content – every note is built from the ledger item's own text, call and output.

import type { EngineTurnResult, RebuildItem } from './types.ts';
import { boundOutput } from './output.ts';

export { boundOutput };
/** The summary of a native call's arguments in its note. */
const SUMMARY_CHARS = 200;

/** The item's text with its restore stamp appended verbatim (condensed items). */
export function withStamp(text: string, stamp?: string): string {
  if (!stamp) return text;
  return text.trim() ? `${text}\n${stamp}` : stamp;
}

/** B-049 F9: a code-mode script's first line that says something (no blank line, no `// @exec:` pragma), at most `max` characters. */
export function scriptLine(source: string, max = 120): string {
  const line = source.split('\n').map((entry) => entry.trim()).find((entry) => entry && !/^\/\/\s*@exec:/.test(entry)) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A short line for a native call's arguments: the command, the path(s), the query or a script's first line, else compact JSON. */
export function argsSummary(args: unknown): string {
  if (typeof args === 'string') return args.slice(0, SUMMARY_CHARS);
  if (args && typeof args === 'object') {
    const record = args as Record<string, unknown>;
    for (const key of ['command', 'cmd', 'query', 'file_path', 'path', 'url', 'pattern', 'description', 'source']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return key === 'source' ? scriptLine(value, SUMMARY_CHARS) : value.slice(0, SUMMARY_CHARS);
      if (Array.isArray(value) && value.length) return value.map(String).join(' ').slice(0, SUMMARY_CHARS);
    }
    if (Array.isArray(record.files) && record.files.length) return record.files.map(String).join(', ').slice(0, SUMMARY_CHARS);
  }
  try { return (JSON.stringify(args) ?? '').slice(0, SUMMARY_CHARS); } catch { return ''; }
}

/** The assistant-side note of a call the target CLI cannot replay natively. */
export function ranNote(call: NonNullable<RebuildItem['call']>): string {
  const summary = argsSummary(call.args);
  return `[ran ${call.name}${summary ? `: ${summary}` : ''}]`;
}

/**
 * The whole assistant-side note: the "[ran …]" line, `detail` (an edit's diff, a script's source) and – B-049 F9 – `calls`,
 * the line naming what a code-mode script called inside it (code-mode.ts callsLine).
 */
export function noteText(call: NonNullable<RebuildItem['call']>, detail?: string, calls?: string): string {
  return [ranNote(call), detail, calls ? `Calls inside the script: ${calls}.` : ''].filter(Boolean).join('\n');
}

/** The user-side note with that call's output (and its restore stamp when the item was condensed). */
export function outputNote(call: NonNullable<RebuildItem['call']>, stamp?: string): string {
  const failed = call.ok === false ? ' (failed)' : '';
  return withStamp(`[output of ${call.name}${failed}]\n${boundOutput(call.output || '(no output)')}`, stamp);
}

/** A model's family: the provider prefix and the variant suffix dropped ("codex:gpt-6.1-sol-mini" → "gpt-6.1"). */
export function modelFamily(model: string | undefined): string {
  const id = (model ?? '').toLowerCase().replace(/^[a-z0-9_-]+:/, '').replace(/\[.*\]$/, '');
  return id.split('-').slice(0, 2).join('-');
}

/** Whether a reasoning item may be replayed natively: same engine, same account and same model family. */
export function sameReasoningSource(item: RebuildItem, target: { engine: string; accountId: string; model: string }): boolean {
  const origin = item.origin;
  return origin?.engine === target.engine && origin.accountId === target.accountId && modelFamily(origin.model) === modelFamily(target.model);
}

/**
 * The first turn on a rebuilt session failed in a way the rebuilt history may have caused (the CLI or the
 * API refused it): reported as an ended session (details.rebase, rebuild 'failed'), so the executor drops
 * at once to today's renewal. Limits, sign-outs, outages and stops stay as they are.
 */
export function rebuiltTurnFailed(result: EngineTurnResult): EngineTurnResult {
  if (result.stop !== 'error' || result.error?.code !== 'internal') return result;
  return { ...result, session: undefined, error: { code: 'conflict', message: 'The rebuilt session could not continue.', details: { rebase: true, rebuild: 'failed', cause: result.error.message } } };
}

/** Whether a call replays as a real call of ours (any tool of the app, offered this turn or not): every call that was not engine-native. */
export function oursCall(call: NonNullable<RebuildItem['call']>): boolean {
  return call.own !== true && call.name !== 'tool';
}
