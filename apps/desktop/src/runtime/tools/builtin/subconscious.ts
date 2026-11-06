// The main AI's own call of the subconscious (owner 15.10.2026: "dass sie selbst einen Aufruf als Unterbewusstsein mit
// einer Frage stellen kann"): the same flow as the automatic runs (subconscious/flow.ts), with `ask` as the task and as much
// of the chat as `context` says; the answer comes back as this tool's output. A core tool, offered in every mode.
// Owns: the definition and its short spec. Never: decides anything itself or waits beyond the flow's own budget.

import type { ToolDef } from '../types.ts';
import { failure, text } from '../types.ts';
import { clip, defineTool, internal, readChat } from './util.ts';

export const SUBCONSCIOUS_TOOL = 'subconscious';

const subconscious = defineTool<{ ask: string; context?: 'none' | 'recent' | 'chat' }>({
  name: SUBCONSCIOUS_TOOL,
  description: 'My subconscious keeps memory and context. ask: any text (a question, a topic, what it should do). context: how much of this chat goes along (default recent). Its answer is the output.',
  inputSchema: {
    type: 'object',
    properties: { ask: { type: 'string', minLength: 1, maxLength: 4000 }, context: { type: 'string', enum: ['none', 'recent', 'chat'] } },
    required: ['ask'], additionalProperties: false,
  },
  category: 'think',
  anyMode: true,
  describe: (args) => internal(`Ask the subconscious: ${clip(args.ask, 80)}`),
  async run(args, ctx) {
    const ask = ctx.services.subconscious.ask;
    if (!ask) return failure('The subconscious is not available here.');
    return text(await ask.call(ctx.services.subconscious, { agent: ctx.agent, conversationId: readChat(ctx), taskId: ctx.taskId, mode: ctx.mode, ask: args.ask, context: args.context, signal: ctx.signal }));
  },
});

export const subconsciousTools: ToolDef[] = [subconscious];
