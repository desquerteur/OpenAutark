// MCP-safe tool names for the hub. Clients see our tools as `mcp__workforce__<wire>` (Claude
// Code) and provider function names must match ^[a-zA-Z0-9_-]{1,64}$, while ours are dotted
// ("tasks.create" → "tasks__create", see engines/shared.ts toWireName).
// Owns: our name ↔ wire name mapping for the hub. Never: decides which tools are offered.

import { toWireName } from '../engines/shared.ts';
import type { ToolSpec } from '../tools/types.ts';

/** Server name the engines register the hub under (= HUB_SERVER in engines/claude/stream.ts). */
export const MCP_SERVER_NAME = 'workforce';
const QUALIFIED = `mcp__${MCP_SERVER_NAME}__`;

export function mcpWireName(name: string): string {
  return toWireName(name);
}

/** Maps between the offered tools and the names a client calls them by. */
export class McpToolNames {
  private readonly byWire = new Map<string, string>();
  private readonly offered = new Set<string>();

  constructor(specs: ToolSpec[]) {
    for (const spec of specs) {
      this.offered.add(spec.name);
      const wire = mcpWireName(spec.name);
      if (!this.byWire.has(wire)) this.byWire.set(wire, spec.name); // first (sorted) name wins a clash
    }
  }

  wire(name: string): string {
    return mcpWireName(name);
  }

  /** Our tool name for what a client sent (wire name, `mcp__workforce__…` or dotted name). */
  resolve(called: string): string | undefined {
    const name = called.startsWith(QUALIFIED) ? called.slice(QUALIFIED.length) : called;
    const direct = this.byWire.get(name);
    if (direct) return direct;
    return this.offered.has(name) ? name : undefined;
  }
}
