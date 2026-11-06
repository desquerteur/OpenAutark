// The pointer lease (B-055 Q10): one PC has one mouse and one keyboard focus, so at any moment
// one agent holds them. Its pointer and keyboard steps (clicks, moves, drags, wheel, typing, keys,
// focusing or moving windows – computer.act click/focus/window_* included) renew the lease; it
// lasts LEASE_TTL_MS after the holder's last such step ended (and for as long as one runs).
// Another agent's pointer or keyboard step meanwhile is refused with one sentence naming the
// holder and its window; element pattern actions (invoke, set_value, toggle, expand, select,
// scroll_into_view …) need neither and run in parallel (computer/quiet-actions.ts runs a refused
// computer.act click as its pattern action where that is the same step). Agents of linked PCs
// count like this PC's own: their calls run through this PC's ComputerService with the caller
// identity runRemoteTool sets (ctx.agent + ctx.fromPc – callerOf below).
// Why no separate desktops: one Windows session has one input queue, one cursor and one
// keyboard focus; virtual desktops (Win+Ctrl+D) share them, hidden desktops (CreateDesktop)
// are invisible to the person and a malware technique, and a second session needs Server/RDS
// licences – so agents take turns on the pointer and work in the background via UI Automation.
// Owns: the holder, its expiry, the refusal and its marker (isLeaseRefusal). Never: judges the
// person's presence (presence.ts – the person is never leased) or waits for the lease itself.

import { WorkforceError } from '../../shared/errors.ts';

/** How long the lease outlasts the holder's last pointer or keyboard step. */
export const LEASE_TTL_MS = 8000;

/** Who calls a computer step: an agent of this PC, or of a linked PC (fromPc: that PC's name). */
export interface ComputerCaller {
  /** Unique per agent and PC: the agent id, prefixed with the linked PC's name. */
  key: string;
  id: string;
  name: string;
  fromPc?: string;
}

/** The caller of a tool call (ctx.agent, and ctx.fromPc for a call run here for a linked PC). */
export function callerOf(ctx: { agent: { id: string; name: string }; fromPc?: string }): ComputerCaller {
  const fromPc = ctx.fromPc || undefined;
  return { key: fromPc ? `${fromPc}/${ctx.agent.id}` : ctx.agent.id, id: ctx.agent.id, name: ctx.agent.name, ...(fromPc ? { fromPc } : {}) };
}

interface Holder { caller: ComputerCaller; busy: number; until: number; window?: number }

const refusals = new WeakSet<WorkforceError>();

/** This error says another agent holds the mouse and keyboard – not that the step failed. */
export function isLeaseRefusal(error: unknown): boolean {
  return error instanceof WorkforceError && refusals.has(error);
}

export class PointerLease {
  private holder: Holder | undefined;
  private readonly now: () => number;
  private readonly titleOf: (hwnd: number) => string | undefined;

  constructor(deps: { now: () => number; titleOf?: (hwnd: number) => string | undefined }) {
    this.now = deps.now;
    this.titleOf = deps.titleOf ?? (() => undefined);
  }

  /** The agent holding the mouse and keyboard now (undefined: free). */
  current(): { caller: ComputerCaller; window?: number; untilMs: number } | undefined {
    const holder = this.live();
    return holder ? { caller: holder.caller, window: holder.window, untilMs: holder.busy > 0 ? LEASE_TTL_MS : Math.max(0, holder.until - this.now()) } : undefined;
  }

  /** Throws the refusal when another agent holds the lease; no caller (internal calls) is never refused. */
  check(caller: ComputerCaller | undefined): void {
    if (!caller) return;
    const holder = this.live();
    if (holder && holder.caller.key !== caller.key) throw this.refusal(holder);
  }

  /**
   * Takes (or keeps) the lease for one step: checked again, held while the step runs, and
   * `end()` lets it run out LEASE_TTL_MS later. `window`: where the step works, when known.
   */
  begin(caller: ComputerCaller | undefined, window?: number): () => void {
    if (!caller) return () => undefined;
    this.check(caller);
    let holder = this.holder;
    if (!holder || holder.caller.key !== caller.key) holder = this.holder = { caller, busy: 0, until: 0 };
    holder.caller = caller;
    holder.busy++;
    if (window !== undefined) holder.window = window;
    let ended = false;
    const own = holder;
    return () => {
      if (ended) return;
      ended = true;
      own.busy = Math.max(0, own.busy - 1);
      own.until = this.now() + LEASE_TTL_MS;
    };
  }

  /** Where the holder works now (a later step names its window). */
  noteWindow(caller: ComputerCaller | undefined, window: number | undefined): void {
    if (caller && window !== undefined && this.holder?.caller.key === caller.key) this.holder.window = window;
  }

  private live(): Holder | undefined {
    const holder = this.holder;
    if (!holder) return undefined;
    if (holder.busy > 0 || this.now() < holder.until) return holder;
    this.holder = undefined;
    return undefined;
  }

  private refusal(holder: Holder): WorkforceError {
    const title = holder.window !== undefined ? this.titleOf(holder.window) : undefined;
    const where = title ? ` (in "${title.replace(/\s+/g, ' ').slice(0, 60)}")` : '';
    const waitMs = holder.busy > 0 ? LEASE_TTL_MS : Math.max(1000, holder.until - this.now());
    const error = new WorkforceError('conflict',
      `${holder.caller.name} (agent) is using the mouse and keyboard on this PC right now${where} – use computer.act pattern actions (invoke, set_value, toggle, select, expand), which run in the background without the mouse, or retry in a few seconds.`,
      { retryAfterMs: waitMs, details: { lease: { holder: holder.caller.name } } });
    refusals.add(error);
    return error;
  }
}
