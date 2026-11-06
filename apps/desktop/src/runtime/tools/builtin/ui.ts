// The rich-answer guide on demand (F08, P23): ui.help returns shared/blocks/prompt.ts blockHelp
// for one topic – a ```ui block type (props, the answer an ask block brings back, limits, an
// example), the ```app mini-tool guide (--wf-* theme variables, one column without inner
// scrolling, the wf API with wf.state, todo=/reason=/permissions=), mermaid, or "blocks" for the
// topic index. Offered like every builtin: through the MCP hub (Codex, Claude, ACP agents) and as a
// function tool (HTTP engines), exposed as `ui__help`; the stable prompt names it only when the
// agent's mode offers it (context/prompt-stable.ts blockOptions). B-049 F5: the stable prompt keeps one rich-answer
// line (shared/blocks/prompt.ts blockLine); the quick reference it carried before is topic "blocks" here.
// Owns: the ui.help definition. Never: renders, posts or changes anything – it only reads the
// block catalog.

import type { ToolDef } from '../types.ts';
import { text } from '../types.ts';
import { blockHelp } from '../../../shared/blocks/prompt.ts';
import { defineTool, internal } from './util.ts';

/** Our name of the help tool (engines see `ui__help`, see engines/shared.ts toWireName). */
export const UI_HELP_TOOL = 'ui.help';

const help = defineTool<{ topic: string }>({
  name: UI_HELP_TOOL,
  description: 'The rich-answer guide by topic: "blocks" (quick reference and every topic), "app" (```app mini-tools), "mermaid" or a ```ui block type such as "chart" (its props, the answer I get, an example).',
  inputSchema: {
    type: 'object',
    properties: { topic: { type: 'string', minLength: 1, maxLength: 40 } },
    required: ['topic'],
    additionalProperties: false,
  },
  category: 'read',
  describe: (args) => internal(`Read the rich-answer guide for ${String(args.topic).trim().slice(0, 40)}`),
  async run(args) {
    return text(blockHelp(args.topic));
  },
});

export const uiTools: ToolDef[] = [help];
