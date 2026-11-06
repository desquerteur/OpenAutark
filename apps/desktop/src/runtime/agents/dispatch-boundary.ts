// Tool boundaries of one running turn (21.10. 17:09: urgent messages reach running work without
// destroying it): which tool calls are in flight – by call id. An interrupt that is not the person's
// own Stop runs only at a boundary: no call in flight. A deferred interrupt runs once, when the last
// running call ends; a turn that ends first simply drops it (cancel). While an important message waits
// for the boundary, one quiet line in its chat says so (noteDeferred) – an engine-native call may run
// long, and the emergency stop stays the way to cut it. Who reports what: engine-native calls from the
// engine's tool_start/tool_end (turn-attempt.ts), our calls from the tool registry
// (ToolRegistryOptions.onCall: dynamic tools, function calls and MCP hub calls alike, under the
// registry's call id).
// Owns: that bookkeeping, the one deferred action and that line. Never: aborts anything itself, judges
// a call, or times out a running call (a call that never reports its end is cut by the turn's own end).

import type { RuntimeServices } from '../contracts.ts';

/** One quiet line in the important message's chat: it reaches the agent after its current step. */
export function noteDeferred(services: RuntimeServices, agentId: string, conversationId: string): void {
  try {
    const name = services.org.get(agentId)?.name ?? 'The agent';
    services.chats.status(conversationId, { type: 'note', text: `${name} reads the important message after the current step.`, details: { deferredUrgent: true } }, { authorId: agentId });
  } catch (error) {
    services.log.warn('deferred interrupt line not written', { agentId, error: String(error) });
  }
}

export class ToolBoundary {
  private readonly running = new Set<string>();
  private pending?: () => void;
  private anonymous = 0;

  /** A tool call started (`true`) or ended (`false`). Repeated starts and unknown ends change nothing. */
  tool(callId: string, running: boolean): void {
    const id = callId || `anonymous:${running ? ++this.anonymous : this.anonymous--}`;
    if (running) { this.running.add(id); return; }
    if (this.running.delete(id)) this.check();
  }

  /** No call is doing work right now. */
  get safe(): boolean {
    return this.running.size === 0;
  }

  /** Calls in flight. */
  get inFlight(): number {
    return this.running.size;
  }

  /**
   * Runs `action` now when no call is doing work, else once at the next boundary (a later request
   * replaces an earlier one that has not run). True when it ran now.
   */
  at(action: () => void): boolean {
    if (this.safe) {
      this.pending = undefined;
      action();
      return true;
    }
    this.pending = action;
    return false;
  }

  /** Whether an action waits for the boundary. */
  get deferred(): boolean {
    return this.pending !== undefined;
  }

  /** The turn ended: nothing waits for its boundary any more. */
  cancel(): void {
    this.pending = undefined;
  }

  private check(): void {
    if (!this.pending || !this.safe) return;
    const action = this.pending;
    this.pending = undefined;
    action();
  }
}
