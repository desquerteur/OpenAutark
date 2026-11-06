// What the computer.* tools add for B-055: the `motion` argument of the pointer tools (Q9) and the
// short lines about others under a result (Q8/Q10): who else points on this screen (the person,
// other agents – screen-pointers.ts) and that another agent worked in the same window lately
// (window-memory.ts). Purely factual lines – agents decide themselves how to share the work.
// Owns: the motion schema and description, and how the lines are appended (at most three about
// pointers, one about the window). Never: refuses or changes a step.

import type { ToolDef, ToolOutput } from '../tools/types.ts';
import { MOTION_STYLES } from '../../shared/model/pointer-motion.ts';
import { callerOf, type ComputerCaller } from './lease.ts';

/** The pointer tools' `motion` (default glide, the shared model's DEFAULT_MOTION). */
export const MOTION_ARG = {
  type: 'string', enum: [...MOTION_STYLES],
  // Sent on four tools every turn, so it stays one short sentence (computer/motion.test.ts).
  description: "How I move the pointer: 'glide' (default, short and visible), 'human' (a curved, hand-like path – real mouse movement an app or a person sees), 'instant' (a jump, fastest for batches).",
};

/** `output` with `lines` appended to its last text part (empty lines dropped). */
export function withNotes(output: ToolOutput, ...lines: Array<string | undefined>): ToolOutput {
  const extra = lines.filter((line): line is string => Boolean(line && line.trim()));
  if (!extra.length) return output;
  const content = [...output.content];
  const at = content.map((part) => part.type).lastIndexOf('text');
  const last = at >= 0 ? content[at] : undefined;
  if (last && last.type === 'text') content[at] = { type: 'text', text: `${last.text}\n${extra.join('\n')}` };
  else content.push({ type: 'text', text: extra.join('\n') });
  return { ...output, content };
}

/** Every tool's result also says who else points on this screen (nothing when nobody else is there). */
export function withOthers(tools: ToolDef[], others: (caller: ComputerCaller) => string): ToolDef[] {
  return tools.map((tool) => ({
    ...tool,
    run: async (args, ctx) => {
      const output = await tool.run(args, ctx);
      let line = '';
      try { line = others(callerOf(ctx)); } catch { line = ''; }
      return withNotes(output, line);
    },
  }));
}
