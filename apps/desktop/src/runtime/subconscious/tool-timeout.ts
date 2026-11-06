// The subconscious's timeout choice, also usable by choice-only System One decision models.
// Owns: the timeout tool output and seconds suggestions. Never: cancels a process or reruns a command.

import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { ToolTimeoutDecision, ToolTimeoutInput } from '../tools/timeout.ts';
import { outcomeOf } from '../decision/service.ts';
import { TIMEOUT_REVIEW_MS } from '../tools/timeout.ts';

export async function chooseToolTimeout(services: RuntimeServices, input: ToolTimeoutInput & { agent: Agent; signal: AbortSignal }): Promise<ToolTimeoutDecision> {
  const suggestions = [15, 30, 60, 120, 300, 600, 1800];
  const options = [...suggestions.map((seconds) => `Wait ${seconds} seconds`), 'Abort'];
  const output = {
    status: 'timeout', stillRunning: true, tool: input.tool, args: JSON.stringify(input.args ?? {}).slice(0, 4000),
    elapsedSeconds: input.elapsedSeconds, timeoutSeconds: input.timeoutSeconds, output: input.output,
    instruction: 'I decide whether this call still needs time: how many more seconds until the next timeout, or abort. An install normally needs longer than grep. Output and status messages do not reset its deadline.',
  };
  const result = await services.decisions.decide({
    type: 'choice', purpose: 'other',
    question: `As the subconscious of ${input.agent.name}: what do I do with this tool timeout – a waiting interval in seconds, or Abort?`,
    options, context: `Tool output (the call is still running):\n${JSON.stringify(output)}`, timeoutMs: TIMEOUT_REVIEW_MS, signal: input.signal,
  });
  const index = options.indexOf(result.choice ?? '');
  if (outcomeOf(result) === 'choice' && index >= 0 && index < suggestions.length) {
    return { action: 'wait', seconds: suggestions[index], reason: `The decision model chose another ${suggestions[index]} seconds.`, by: result.by };
  }
  return { action: 'abort', reason: outcomeOf(result) === 'choice' && result.choice === 'Abort' ? 'The decision model chose to abort.' : 'The decision model could not choose a waiting interval; returning control to the main AI.', by: result.by };
}
