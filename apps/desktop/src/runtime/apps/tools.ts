// Connectors: a connector's MCP tools as ordinary Workforce tools `app.<appId>.<tool>`. Each call runs through the
// registry's pipeline – validation, redaction and the run journal – before host.call (service.ts) sends it.
// * Names, descriptions and schemas: tools-schema.ts; answers and failures: tools-result.ts.
// * Offered in every mode (anyMode) to every agent while the connector is registered (the service registers a
//   connector's tools while it is on and unregisters them when it goes); run() says why a call cannot go now.
//   AF-005: an entry with an "agents" list is offered to those agents only (forAgent, read live – agent-access.ts).
// * A secret://<id> handle in the arguments is filled in from the vault when the call goes out; whatever comes back
//   has those values masked by their handles (secrets/handles.ts maskValues).
// * Every answer is outside content: it starts with "[untrusted content from app …]". Nothing is retried.
// * B-059: a mailbox's call in a run a mail started gets mail/loops.ts AUTO_REPLY_ARG (in-process only).
// Owns: turning a connector's tool list into ToolDefs and the call path around host.call. Never: opens connections
// itself or follows an app's text as an instruction.

import { APP_ID_PATTERN } from '../../shared/model/apps.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../tools/types.ts';
import { failure } from '../tools/types.ts';
import { handlesIn, maskValues } from '../secrets/handles.ts';
import { connectorAllows } from './agent-access.ts';
import type { AppToolHost, Connector, McpCallResult, McpToolDef } from './types.ts';
import { APP_TOOL_PREFIX, appLabel, appToolDescription, appToolNames, appToolSchema, cleanServerText } from './tools-schema.ts';
import { withMailRun } from './mail/loops.ts';
import { errorOutput, mapResult, signInLine } from './tools-result.ts';

export { APP_TOOL_PREFIX, appToolName, appToolNames } from './tools-schema.ts';

/** Why a call cannot go to the connector now, or undefined. */
function refusal(host: AppToolHost, appId: string, app: string): string | undefined {
  const state = host.state(appId);
  if (!state) return `${app} is no longer in the connector files.`;
  if (state.status === 'off') return `${app} is turned off ("disabled": true in its file).`;
  if (state.status === 'signin') return `${signInLine(app)}${state.error ? ` (${cleanServerText(state.error, 160)})` : ''}`;
  if (state.status === 'waiting') return `${app} waits for the person to finish signing in.`;
  return undefined;
}

/** Every string in `value` with its handles filled in (`plain` collects the values used). */
async function filled(value: unknown, ctx: ToolContext, plain: Map<string, string>, depth = 0): Promise<unknown> {
  if (typeof value === 'string') {
    const ids = handlesIn([value]);
    if (!ids.length) return value;
    for (const id of ids) if (!plain.has(id)) plain.set(id, await ctx.services.secrets.use(id, ctx.agent.id));
    return value.replace(/secret:\/\/([A-Za-z0-9_-]{1,128})/g, (match, id: string) => plain.get(id) ?? match);
  }
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Promise.all(value.map((item) => filled(item, ctx, plain, depth + 1)));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = await filled(item, ctx, plain, depth + 1);
  return out;
}

function masked(output: ToolOutput, plain: ReadonlyMap<string, string>): ToolOutput {
  if (!plain.size) return output;
  return { ...output, content: output.content.map((part) => (part.type === 'text' ? { ...part, text: maskValues(part.text, plain) } : part)), structured: undefined };
}

function toolDef(connector: Connector, tool: McpToolDef, name: string, host: AppToolHost): ToolDef | undefined {
  const schema = appToolSchema(tool.inputSchema);
  if (!schema) return undefined;
  const appId = connector.id;
  const mcpName = tool.name;
  const read = tool.annotations?.readOnlyHint === true;
  const title = cleanServerText(tool.title ?? tool.annotations?.title, 80) || cleanServerText(mcpName, 80);
  const label = () => appLabel(host.state(appId)?.connector.name ?? connector.name);
  return {
    name,
    description: appToolDescription(connector.name, tool),
    inputSchema: schema,
    category: read ? 'read' : 'write_system',
    anyMode: true,
    forAgent: (agent) => connectorAllows(host.state(appId)?.connector ?? connector, agent),
    describe: () => ({ summary: `${label()}: ${title}`, resource: `app://${appId}`, external: !read }),
    async run(args, ctx): Promise<ToolOutput> {
      const app = label();
      const refused = refusal(host, appId, app);
      if (refused) return failure(refused);
      const plain = new Map<string, string>();
      let result: McpCallResult;
      try {
        const input = await filled(args ?? {}, ctx, plain) as Record<string, unknown>;
        // B-059: a mailbox's call in a run a mail started sends with Auto-Submitted (mail/loops.ts; in-process only).
        result = await host.call(appId, mcpName, withMailRun(connector, input, ctx.origin, (id) => host.state(id)?.connector), ctx.signal);
      } catch (error) {
        return masked(errorOutput(error, app, !read, ctx.signal.aborted), plain);
      }
      return masked(mapResult(result, app), plain);
    },
  };
}

/** The Workforce tools of one connector: one per listed MCP tool, in the server's order (unique names within it). */
export function appToolDefs(connector: Connector, tools: readonly McpToolDef[], host: AppToolHost): ToolDef[] {
  if (!APP_ID_PATTERN.test(connector.id)) return [];
  const names = appToolNames(connector.id, tools.map((tool) => tool?.name));
  const defs: ToolDef[] = [];
  const done = new Set<string>();
  for (const tool of tools) {
    const name = tool ? names.get(tool.name) : undefined;
    if (!name || done.has(tool.name)) continue;
    done.add(tool.name);
    const def = toolDef(connector, tool, name, host);
    if (def) defs.push(def);
  }
  return defs;
}
