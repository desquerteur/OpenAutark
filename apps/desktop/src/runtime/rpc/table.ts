// The RPC handler table: every method of src/shared/api/methods.ts is registered here by one
// handler module (src/runtime/rpc/handlers/<domain>.ts) together with the scopes allowed to
// call it. The server (server.ts) looks methods up here; nothing else dispatches RPC.
// C8: an external agent (scope kind 'external', bridges/external-agents.ts) reaches only methods
// that also have an external variant (`addExternal`): the table then serves that variant for it
// and the person's handler for everyone else, and marks the rule `external`.
// F-52: a person of the organisation (scope kind 'person', runtime/people) likewise reaches only methods
// with a person variant (`addPerson`, rule `{ person: true, base }`); everything else is closed to people.
// Owns: handler/registration types, the scope-rule vocabulary and the device tier checks
// (capabilities; 'permissions' and rules marked `secure` need a secure transport).
// Never: business logic (handlers delegate to RuntimeServices / RpcExtras), or runs a person's
// handler for an external agent.

import type { MethodName, ParamsOf, ResultOf } from '../../shared/api/methods.ts';
import type { ClientScope, DeviceCapability, Topic } from '../../shared/api/protocol.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { RpcExtras } from './extras.ts';

/** Every device capability in canonical order (the owner holds all of them). */
export const ALL_CAPABILITIES: readonly DeviceCapability[] = ['todo', 'chat', 'tasks', 'settings', 'manage', 'permissions'];
/** Capabilities that only count on a secure transport (loopback, local https proxy, tailnet). */
const SECURE_ONLY: ReadonlySet<DeviceCapability> = new Set(['permissions']);

/** Who may call a method. 'owner' = desktop window / main / local CLI with the launch token. */
export type ScopeRule =
  | 'owner' // owner only (default)
  | 'any' // owner + every authenticated device (still filtered by the handler if needed)
  | { capability: DeviceCapability; secure?: true; external?: true } // owner + devices holding this capability (on a secure transport when marked); `external` is set by the table (addExternal)
  | { person: true; base: ScopeRule }; // F-52: also open to people (set by the table, addPerson); `base` rules everyone else

/** Per-call context handed to handlers. */
export interface HandlerContext {
  scope: ClientScope;
  services: RuntimeServices;
  extras: RpcExtras;
  /** The connection's live subscription set (events.subscribe/unsubscribe mutate it). */
  topics: Set<Topic>;
  /** Aborted when the connection closes (long calls may observe it). */
  signal: AbortSignal;
  /** Set by the server: owner, or a device on a secure transport. Absent counts as not secure. */
  secure?: boolean;
}

export type Handler<M extends MethodName> = (params: ParamsOf<M>, ctx: HandlerContext) => Promise<ResultOf<M>> | ResultOf<M>;

export interface HandlerEntry {
  handler: Handler<MethodName>;
  scope: ScopeRule;
}

export class HandlerTable {
  private readonly entries = new Map<string, HandlerEntry>();
  /** C8: what an external agent's call runs, per method (its own checks, never the person's handler). */
  private readonly externals = new Map<string, Handler<MethodName>>();
  private readonly merged = new Map<string, HandlerEntry>();
  /** F-52: what a person's call runs, per method (its own checks, never the owner's handler). */
  private readonly persons = new Map<string, Handler<MethodName>>();

  /** Registers one method. A method may be registered only once (duplicates are a bug). */
  add<M extends MethodName>(method: M, handler: Handler<M>, scope: ScopeRule = 'owner'): void {
    if (this.entries.has(method)) throw new Error(`RPC method registered twice: ${method}`);
    if (typeof scope === 'object' && ('person' in scope || scope.external)) throw new Error(`Only addExternal / addPerson open a method to external agents or people: ${method}`);
    this.entries.set(method, { handler: handler as unknown as Handler<MethodName>, scope });
    this.merged.delete(method); // a variant registered first may have been merged without it
  }

  /**
   * C8: the external-agent variant of `method` (registered before or after the method itself). It
   * opens only methods with a capability rule; 'owner' and 'any' methods stay closed to external agents.
   */
  addExternal<M extends MethodName>(method: M, handler: Handler<M>): void {
    if (this.externals.has(method)) throw new Error(`External RPC variant registered twice: ${method}`);
    this.externals.set(method, handler as unknown as Handler<MethodName>);
    this.merged.delete(method);
  }

  /**
   * F-52: the person variant of `method` (registered before or after the method itself; a method
   * may also exist for people only – then its base rule is 'owner').
   */
  addPerson<M extends MethodName>(method: M, handler: Handler<M>): void {
    if (this.persons.has(method)) throw new Error(`Person RPC variant registered twice: ${method}`);
    this.persons.set(method, handler as unknown as Handler<MethodName>);
    this.merged.delete(method);
  }

  get(method: string): HandlerEntry | undefined {
    const entry = this.entries.get(method);
    const external = this.externals.get(method);
    const person = this.persons.get(method);
    if (!person && (!entry || !external || typeof entry.scope !== 'object')) return entry;
    let both = this.merged.get(method);
    if (!both) {
      const refuse: Handler<MethodName> = () => { throw new Error(`No owner handler for ${method}`); };
      const base: HandlerEntry = entry && external && typeof entry.scope === 'object' && !('person' in entry.scope)
        ? { scope: { ...entry.scope, external: true }, handler: (params, ctx) => (ctx.scope.kind === 'external' ? external(params, ctx) : entry.handler(params, ctx)) }
        : entry ?? { scope: 'owner', handler: refuse };
      both = person
        ? { scope: { person: true, base: base.scope }, handler: (params, ctx) => (ctx.scope.kind === 'person' ? person(params, ctx) : base.handler(params, ctx)) }
        : base;
      this.merged.set(method, both);
    }
    return both;
  }

  methods(): string[] {
    return [...new Set([...this.entries.keys(), ...this.persons.keys()])].sort();
  }
}

/** True for the owner and for a device on a secure transport. */
export function secureScope(scope: ClientScope): boolean {
  return scope.kind === 'owner' || (scope.kind === 'device' && scope.secure === true);
}

/**
 * Why `scope` may not call a method registered with `rule`: 'scope' (wrong kind or missing
 * capability), 'insecure' (capability held, but the transport is plain LAN http), or undefined.
 */
export function scopeDenial(rule: ScopeRule, scope: ClientScope): 'scope' | 'insecure' | undefined {
  if (typeof rule === 'object' && 'person' in rule) return scope.kind === 'person' ? undefined : scopeDenial(rule.base, scope); // F-52
  if (scope.kind === 'person') return 'scope'; // F-52: only person variants
  if (scope.kind === 'owner') return undefined;
  if (scope.kind === 'external') return typeof rule === 'object' && rule.external ? undefined : 'scope'; // C8: only external variants
  if (scope.kind !== 'device') return 'scope'; // peers/agents never use the client RPC surface
  if (rule === 'owner') return 'scope';
  if (rule === 'any') return undefined;
  if (!('capability' in rule) || !scope.capabilities.includes(rule.capability)) return 'scope';
  if ((rule.secure || SECURE_ONLY.has(rule.capability)) && scope.secure !== true) return 'insecure';
  return undefined;
}

/** True when `scope` may call a method registered with `rule`. */
export function allowedScope(rule: ScopeRule, scope: ClientScope): boolean {
  return scopeDenial(rule, scope) === undefined;
}

/** Handler-level check for parts of a method that need a higher tier (owner always passes). */
export function scopeHas(scope: ClientScope, capability: DeviceCapability): boolean {
  return allowedScope({ capability }, scope);
}

/** The capabilities a scope holds (all for the owner, none for peers/agents). */
export function capabilitiesOf(scope: ClientScope): DeviceCapability[] {
  if (scope.kind === 'owner') return [...ALL_CAPABILITIES];
  return scope.kind === 'device' ? ALL_CAPABILITIES.filter((capability) => scope.capabilities.includes(capability)) : [];
}

/** Signature every handler module exports: `export function register(table: HandlerTable): void`. */
export type HandlerModule = (table: HandlerTable) => void;
