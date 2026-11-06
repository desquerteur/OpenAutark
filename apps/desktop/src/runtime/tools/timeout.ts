// Adaptive deadlines shared by shell commands and engine-native tools. An abort says that the app stopped the call
// (B-072, live 03.11.2026: an app timeout was read as the person's "no" and became a team rule).
// Owns: initial estimates, bounded subconscious reviews and their journal. Never: restarts a command or exposes secrets.

import type { ToolContext } from './types.ts';
import { preview } from './outputs.ts';

export interface ToolTimeoutInput {
  tool: string;
  args: unknown;
  elapsedSeconds: number;
  timeoutSeconds: number;
  output: string;
}

export interface ToolTimeoutDecision {
  action: 'wait' | 'abort';
  seconds?: number;
  reason: string;
  by?: string;
}

export const TIMEOUT_REVIEW_MS = 120_000;
export const MAX_TIMEOUT_SECONDS = 1800;

/** An estimate until the first review, not a maximum lifetime. Explicit command limits take precedence. */
export function initialTimeoutSeconds(name: string, args: unknown): number {
  const record: Record<string, unknown> = typeof args === 'string' ? { command: args } : args && typeof args === 'object' ? args as Record<string, unknown> : {};
  if (typeof record.timeoutSeconds === 'number' && Number.isFinite(record.timeoutSeconds)) return Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, record.timeoutSeconds));
  const command = [record.command, record.cmd, record.script, record.source].flatMap((value) => Array.isArray(value) ? value : [value]).filter((value) => typeof value === 'string').join(' ');
  const quick = /^\s*(?:rg|grep|findstr|select-string|git\s+(?:status|diff|log)|ls|dir|pwd|cat|head|tail|echo|Get-Content|Get-ChildItem)\b/i.test(command);
  if ((quick && !/[;&|\n]/.test(command)) || /grep|glob|search|read|list/i.test(name)) return 15;
  // Match executable/subcommand pairs rather than argument words: `rg install` is still a search.
  if (/\b(?:npm|pnpm|yarn|bun|pip\d?|uv|poetry|conda|brew|apt(?:-get)?|winget|choco|scoop|dotnet|cargo|git)\b[^;&|\n]*\b(?:install|ci|update|upgrade|download|clone|fetch|pull|restore|add)\b/i.test(command) || /^\s*(?:curl|wget|Invoke-WebRequest|Start-BitsTransfer)\b/i.test(command)) return 300;
  if (/\b(?:npm|pnpm|yarn|bun|dotnet|cargo|gradle|mvn|docker)\b[^;&|\n]*\b(?:build|test|check|compile|typecheck|package|publish)\b/i.test(command) || /(?:^|[;&|])\s*(?:pytest|tsc|webpack|vite|make|cmake)\b/i.test(command)) return 180;
  if (quick) return 15;
  return 60;
}

/** Who stopped an aborted call: the app, not the person (native-timeout.ts says it on the continuation too). */
export const APP_STOPPED = 'The app stopped the running call for its time limit – nobody declined it.';

export function timeoutDecisionText(input: Pick<ToolTimeoutInput, 'tool' | 'elapsedSeconds'>, decision: ToolTimeoutDecision): string {
  const action = decision.action === 'wait' ? `wait another ${decision.seconds} seconds until the next timeout` : 'abort the running call';
  const stopped = decision.action === 'abort' ? `${APP_STOPPED} I check its effects and go on – other ways work too. ` : '';
  return `Subconscious timeout decision for ${input.tool} after ${input.elapsedSeconds}s: ${action}. ${stopped}${decision.reason}${decision.by ? ` (${decision.by})` : ''}`;
}

/** A timeout review is itself bounded, even when a helper ignores cancellation. The running tool may finish during it. */
export async function reviewToolTimeout(ctx: ToolContext, input: ToolTimeoutInput, signal = ctx.signal): Promise<ToolTimeoutDecision> {
  const controller = new AbortController();
  const stop = AbortSignal.any([ctx.signal, signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), TIMEOUT_REVIEW_MS);
  const redact = (value: string) => ctx.services.secrets.redact(value);
  const fallback: ToolTimeoutDecision = { action: 'abort', reason: 'No valid timeout decision arrived; returning control to the main AI.' };
  let cancel: (() => void) | undefined;
  try {
    const clean = { ...input, args: JSON.parse(redact(JSON.stringify(input.args ?? {}))), output: redact(input.output).slice(-6000) };
    const ended = new Promise<ToolTimeoutDecision>((resolve) => {
      cancel = () => resolve(fallback);
      if (stop.aborted) cancel();
      else stop.addEventListener('abort', cancel, { once: true });
    });
    const work = Promise.resolve().then(() => stop.aborted ? fallback : ctx.services.subconscious.toolTimeout?.({ ...clean, agent: ctx.agent, signal: stop }) ?? fallback);
    const answer = await Promise.race([work, ended]);
    const valid = answer.action === 'abort' || (answer.action === 'wait' && Number.isInteger(answer.seconds) && answer.seconds! >= 1 && answer.seconds! <= MAX_TIMEOUT_SECONDS);
    const decision = valid ? { ...answer, reason: redact(answer.reason || 'Timeout reviewed.').slice(0, 500) } : fallback;
    if (!signal.aborted && !ctx.signal.aborted) {
      try {
        ctx.services.runs.item(ctx.runId, { kind: 'note', name: 'tool.timeout', effectStatus: 'none', data: { callId: ctx.callId, toolTimeout: { tool: input.tool, elapsedSeconds: input.elapsedSeconds, timeoutSeconds: input.timeoutSeconds, decision }, summary: preview(ctx.services.secrets, timeoutDecisionText(input, decision), 400) } });
      } catch { /* the result also travels with the tool output */ }
    }
    return decision;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
    if (cancel) stop.removeEventListener('abort', cancel);
    controller.abort();
  }
}
