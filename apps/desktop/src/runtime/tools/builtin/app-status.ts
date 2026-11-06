// app.status: the live state of this app (first run, spaces, agents per space, accounts, usable strong models, the
// models that answer decisions and search by meaning now, cost mode, linked PCs, phones, chat bridges) as the
// '## App status (live)' text, so an agent can check what is connected
// on demand. G1 (01.11.2026): named setup.status before – the name matched "einrichten" and a Codex Manager called it
// first and took the request as configuring the app. Manager-mode prompts carry only the '## Team and models (live)'
// part of these facts (context/setup-facts.ts, E1). No `requires`, but it is not a core tool: the registry offers it
// only in modes whose tool patterns match it (today manager, general and secretary with '*').
// Owns: the tool definition (category read, any agent role).
// Never: collects or renders facts itself (context/setup-facts.ts does) or returns emails, homes, base URLs, secret
// ids or tokens.

import type { ToolDef } from '../types.ts';
import { collectSetupFacts, renderSetupFacts } from '../../context/setup-facts.ts';
import { defineTool, internal } from './util.ts';

export const APP_STATUS_TOOL = 'app.status';

const appStatus = defineTool<Record<string, never>>({
  name: APP_STATUS_TOOL,
  description: 'State of this app right now: agents per space, accounts (provider, label, state, plan), usable strong models, the models that answer decisions and search by meaning now, cost mode, linked PCs, paired phones and chat bridges.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  category: 'read',
  describe: () => internal("Read the app's state"),
  async run(_args, ctx) {
    const facts = collectSetupFacts(ctx.services);
    const text = renderSetupFacts(facts) || "The app's state could not be read right now.";
    return { content: [{ type: 'text', text }], structured: facts };
  },
});

export const appStatusTools: ToolDef[] = [appStatus];
