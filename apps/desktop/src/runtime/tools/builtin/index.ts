// Registers every built-in workforce tool (one file per domain).
// Owns: the list of built-in tool groups and their injected dependencies (shell, fetch).
// Never: registers device/computer/browser tools – those come from devices/tools.ts.

import type { ToolDef } from '../types.ts';
import { chatTools } from './chat.ts';
import { taskTools } from './tasks.ts';
import { humanTools } from './human.ts';
import { scheduleTools } from './schedule.ts';
import { memoryTools } from './memory.ts';
import { subconsciousTools } from './subconscious.ts';
import { agentTools } from './agents.ts';
import { agentOrgTools } from './agents-org.ts';
import { skillTools } from './skills.ts';
import { fileTools, type ShellSpawn } from './files.ts';
import { webTools, type FetchFn } from './web.ts';
import { feedbackTools } from './feedback.ts';
import { mediaTools } from './media.ts';
import { secretTools } from './secrets.ts';
import { secretRunTool } from './secret-run.ts';
import { spaceTools } from './spaces.ts';
import { appStatusTools } from './app-status.ts';
import { modelTools } from './models.ts';
import { uiTools } from './ui.ts';
import { modeTools } from './modes.ts';
import { decideTools } from './decide.ts';
import { splitMergeTools } from './agents-split-merge.ts';
import { referenceTools } from './references.ts';
import { findTools } from './find.ts';
import { notesTools } from './notes.ts';
import { calendarTools } from './calendar.ts';
import { calendarChangeTools } from './calendar-change.ts';
import { peopleTools } from './people.ts';
import { todosPrepareTools } from './todos-prepare.ts';
import { browserShowTools } from '../../browser/show-tool.ts';
import { accountTools } from './accounts.ts';
import { metaTools } from './tools-meta.ts';
import { splitTools } from './agents-split.ts';
import { vectorTools } from './vector-search.ts';
import { contextTools } from './context.ts';
import { spendTools } from './spend.ts';
import { chatTreeTools } from './chat-tree.ts';
import { libraryTools } from './library.ts';

export interface BuiltinDeps {
  shell?: ShellSpawn;
  fetch?: FetchFn;
}

export function builtinTools(deps: BuiltinDeps = {}): ToolDef[] {
  return [
    ...chatTools, ...taskTools, ...humanTools, ...scheduleTools, ...memoryTools, ...agentTools, ...agentOrgTools,
    ...skillTools, ...fileTools({ shell: deps.shell }), ...webTools({ fetch: deps.fetch }),
    ...feedbackTools, ...mediaTools, ...secretTools,
    secretRunTool({ shell: deps.shell }), // secrets.run – a command with secret:// handles in its env, for CLI engines through the MCP hub
    ...spaceTools, ...appStatusTools, ...modelTools, ...uiTools, ...modeTools, ...decideTools,
    ...splitMergeTools, ...referenceTools, ...findTools, ...notesTools,
    ...calendarTools, ...calendarChangeTools, ...peopleTools, ...todosPrepareTools, ...browserShowTools, ...accountTools,
    ...subconsciousTools, // the main AI's own call of the subconscious
    ...metaTools, // tools.find / tools.call – every tool beyond the core set, found and run through the registry
    ...splitTools,
    ...vectorTools, // vector.embed / vector.search, found through tools.find
    ...contextTools, // context.restore, found through tools.find
    ...spendTools, // spend.note, found through tools.find
    ...chatTreeTools, // B-078: chat.set_parent / chat.thread
    ...libraryTools, // B-078: library.* (public library), found through tools.find
  ];
}

export function registerBuiltinTools(registry: { register(tool: ToolDef): void }, deps: BuiltinDeps = {}): void {
  for (const tool of builtinTools(deps)) registry.register(tool);
}
