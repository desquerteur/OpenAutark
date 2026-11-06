// browser.* calls in the person's browser (a chat's area, the person's pane or – browser.show – an agent's area on its
// page, place.ts): one SideBrowserCall to main
// (host op sideBrowser, main/side-driver answers – its tabs, refs 's123', change lists, the agent's named cursor in the
// page and the person-first rule are its own). The call names the agent and the chat it works for, so a tab it opens
// carries both. Elements are addressed by ref (the side driver's refs from its snapshot or find); a stored secret's value is taken
// from the vault here and typed there (the tool output passes the vault's redaction). Without the host op (no desktop
// app here) the call fails with one sentence.
// Owns: that mapping. Never: talks to main except through the host.

import { WorkforceError } from '../../shared/errors.ts';
import type { SideActStep, SideBrowserCall, SideBrowserResult, SideStepAction } from '../../shared/model/side-browser.ts';
import type { ToolContext } from '../tools/types.ts';

export const SIDE_MISSING = "The person's browser is not open here (it lives in the app window on this PC).";
export const SECRET = /^secret:\/\/([A-Za-z0-9_-]{1,64})$/;

const STEP_ACTIONS: ReadonlySet<string> = new Set<SideStepAction>([
  'click', 'double_click', 'right_click', 'hover', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'scroll', 'scroll_into_view', 'back', 'forward', 'reload',
]);
const PAGE_ACTIONS: ReadonlySet<string> = new Set(['press', 'scroll', 'back', 'forward', 'reload']);

/** The step arguments the browser tools share. */
export interface StepArgs {
  action: string; ref?: string; role?: string; name?: string; label?: string; placeholder?: string; text?: string; css?: string;
  value?: string; values?: string[]; key?: string; files?: string[]; amount?: number;
}

/** One act step as the side driver takes it (a stored secret's value filled in). */
export async function sideStep(ctx: ToolContext, args: StepArgs): Promise<SideActStep> {
  if (!STEP_ACTIONS.has(args.action)) throw new WorkforceError('bad_request', `${args.action} works in my own browser, not in the person's.`);
  const other = Boolean(args.role || args.label || args.placeholder || args.text || args.css);
  if (!args.ref && (other || !PAGE_ACTIONS.has(args.action))) throw new WorkforceError('bad_request', "In the person's browser address elements by ref (from browser.snapshot or browser.find there).");
  const secret = args.value !== undefined ? SECRET.exec(args.value)?.[1] : undefined;
  const value = secret ? await ctx.services.secrets.use(secret, ctx.agent.id) : args.value;
  return {
    action: args.action as SideStepAction, ...(args.ref ? { ref: args.ref } : {}), ...(value !== undefined ? { value } : {}),
    ...(args.values ? { values: args.values } : {}), ...(args.key ? { key: args.key } : {}), ...(args.amount !== undefined ? { dy: args.amount } : {}),
  };
}

/**
 * Sends `call` as this agent (for this chat); a refusal there becomes the agent's error – except a batch that ran
 * partly (`partial`: a result with `done`) or any answer (`partial` 'any': browser.wait's "did not come").
 */
export async function sideCall(ctx: ToolContext, call: Omit<SideBrowserCall, 'agent'>, partial: boolean | 'any' = false): Promise<SideBrowserResult> {
  const host = ctx.services.host;
  if (!host.sideBrowser) throw new WorkforceError('unavailable', SIDE_MISSING);
  let result: SideBrowserResult;
  try {
    result = await host.sideBrowser({ ...call, agent: { id: ctx.agent.id, name: ctx.agent.name }, ...(ctx.conversationId ? { chat: ctx.conversationId } : {}) });
  } catch (error) {
    if (error instanceof WorkforceError && error.code === 'unavailable') throw new WorkforceError('unavailable', SIDE_MISSING);
    throw error;
  }
  if (!result || typeof result !== 'object') throw new WorkforceError('internal', "The person's browser gave no answer.");
  if (!result.ok && !(partial === 'any' && !result.personActive) && !(partial && typeof result.done === 'number')) {
    const why = result.error?.slice(0, 400) || "The person's browser could not do this.";
    throw new WorkforceError(result.personActive ? 'conflict' : 'unavailable', why);
  }
  return result;
}

/** The tab line facts of a side result. */
export function sidePage(result: SideBrowserResult): { tab: string; url: string; title: string; humanCheck?: boolean } {
  return { tab: result.tab ?? 'side', url: result.url ?? '', title: result.title ?? '', ...(result.humanCheck ? { humanCheck: true } : {}) };
}
