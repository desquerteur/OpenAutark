// AF-013: Claude Code's permission prompts (`--permission-prompt-tool mcp__workforce__access__prompt`, engines/claude/access.ts)
// answered by the hub (mcp/hub.ts): the hub lists this tool only for a turn that is not unlimited and answers it here – the
// step Claude Code asks about (tool_name + input) is judged like every other (access/service.ts decide), 'ask' waits for
// the person. The answer is Claude Code's documented JSON: {"behavior":"allow","updatedInput":…} or {"behavior":"deny","message":…}.
// The hub's own tools (mcp__workforce__*) are allowed here: the tool registry judges each of them itself.
// Owns: the tool's spec and its answer. Never: changes the step's input.

import type { RuntimeServices } from '../contracts.ts';
import '../contracts/access.ts';
import type { ToolContext, ToolOutput, ToolSpec } from '../tools/types.ts';
import { text } from '../tools/types.ts';
import { claudeActions } from './classify.ts';

export const ACCESS_PROMPT = 'access.prompt';

export const ACCESS_PROMPT_SPEC: ToolSpec = Object.freeze({
  name: ACCESS_PROMPT,
  description: 'The app\'s own permission check: Claude Code calls it before a step that needs approval. I never call it myself.',
  inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name'] },
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether the hub lists the prompt tool for this lease (a turn that is not unlimited). */
export function promptToolWanted(services: Pick<RuntimeServices, 'access'>, ctx: Pick<ToolContext, 'agent' | 'conversationId' | 'runId' | 'split'>): boolean {
  try { return services.access ? !services.access.unlimited(scopeOf(ctx)) : false; } catch { return false; }
}

function scopeOf(ctx: Pick<ToolContext, 'agent' | 'conversationId' | 'runId' | 'split'>) {
  return { agentId: ctx.agent.id, ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}), runId: ctx.runId, ...(ctx.split?.cwd ? { cwd: ctx.split.cwd } : {}) };
}

export async function answerPrompt(services: Pick<RuntimeServices, 'access' | 'paths'>, ctx: Pick<ToolContext, 'agent' | 'conversationId' | 'runId' | 'split'>, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutput> {
  const toolName = typeof args.tool_name === 'string' ? args.tool_name : '';
  const input = isRecord(args.input) ? args.input : {};
  const allow = () => text(JSON.stringify({ behavior: 'allow', updatedInput: input }));
  if (!services.access || toolName.startsWith('mcp__workforce__')) return allow();
  const scope = scopeOf(ctx);
  const cwd = services.access.effective(scope).project ?? services.paths.workspace;
  const decision = await services.access.decide(scope, claudeActions(toolName, input, cwd), 'claude', signal);
  return decision.allow ? allow() : text(JSON.stringify({ behavior: 'deny', message: decision.message }));
}
