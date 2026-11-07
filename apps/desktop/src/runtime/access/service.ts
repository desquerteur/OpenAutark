// AF-013: the access service – the mode in effect for a turn (the run's, else the chat's, else the agent's own, else
// full access), the one decision for an action (rules.ts judges; 'ask' waits for the person in approvals.ts; "Always
// for this agent" adds the grant to the agent's rules) and the person's settings. Every engine asks it: the tool
// registry for the app's own tools, Claude Code through the hub's permission prompt tool, Codex for its approval
// requests, ACP for its permission requests (EngineTurnInput.access, agents/turn-attempt.ts).
// The texts given back speak as the agent (B-075), so a refused step reads as its own note.
// Owns: these decisions and the events of a change. Never: runs a step, or lets an agent change its own access.

import type { AccessAction, AccessAnswer, AccessMode, AccessRequest, AccessRules, AgentAccess, EffectiveAccess } from '../../shared/model/access.ts';
import { DEFAULT_ACCESS_MODE } from '../../shared/model/access.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { ApprovalBroker } from './approvals.ts';
import type { AccessStore } from './store.ts';
import { normalizeRules } from './store.ts';
import { grantText, judge, strictest, withGrant, type Verdict } from './rules.ts';
import { actionSummary, toolActions } from './classify.ts';

export interface AccessScope { agentId: string; conversationId?: string; runId?: string; /** The turn's folder (project changes are free there). */ cwd?: string }

export interface AccessDecision { allow: boolean; message: string; verdict: Verdict }

export interface AccessServiceDeps {
  store: AccessStore;
  broker: ApprovalBroker;
  emit(event: 'access.changed', data: { agentId?: string; conversationId?: string }): void;
  workspace: () => string;
  /** The agent's usable home project (agent-core/home.ts). */
  home: (agentId: string) => string | undefined;
  agentName: (agentId: string) => string;
  platform?: NodeJS.Platform;
}

const hasRules = (rules: AccessRules): boolean => Object.keys(rules).length > 0;

export class AccessService {
  private readonly deps: AccessServiceDeps;

  constructor(deps: AccessServiceDeps) {
    this.deps = deps;
  }

  /** The agent's own stored access, or the default (full, no rules). */
  own(agentId: string): AgentAccess {
    return this.deps.store.agent(agentId) ?? { mode: DEFAULT_ACCESS_MODE, rules: {} };
  }

  effective(scope: AccessScope): EffectiveAccess {
    const own = this.deps.store.agent(scope.agentId);
    const agentMode = own?.mode ?? DEFAULT_ACCESS_MODE;
    const run = scope.runId ? this.deps.store.runMode(scope.runId) : undefined;
    const chat = scope.conversationId ? this.deps.store.chatMode(scope.conversationId) : undefined;
    const mode = run ?? chat ?? agentMode;
    const source = run ? 'run' : chat ? 'chat' : own ? 'agent' : 'default';
    let home: string | undefined;
    try { home = this.deps.home(scope.agentId); } catch { home = undefined; }
    const project = scope.cwd ?? home;
    return { agentId: scope.agentId, mode, agentMode, source, rules: own?.rules ?? {}, ...(project ? { project } : {}) };
  }

  /** Nothing to judge: full access without rules (every call before AF-013). */
  unlimited(scope: AccessScope): boolean {
    const access = this.effective(scope);
    return access.mode === 'full' && !hasRules(access.rules);
  }

  set(agentId: string, patch: { mode?: AccessMode; rules?: AccessRules }): EffectiveAccess {
    const current = this.own(agentId);
    const next: AgentAccess = { mode: patch.mode ?? current.mode, rules: patch.rules !== undefined ? normalizeRules(patch.rules) : current.rules };
    try { this.deps.store.setAgent(agentId, next); } catch (error) {
      if (error instanceof WorkforceError) throw error;
      throw new WorkforceError('unavailable', 'The access could not be saved: access.json in the agent folder cannot be written.');
    }
    this.deps.emit('access.changed', { agentId });
    return this.effective({ agentId });
  }

  setChatMode(conversationId: string, mode: AccessMode | undefined): void {
    this.deps.store.setChatMode(conversationId, mode);
    this.deps.emit('access.changed', { conversationId });
  }

  setRunMode(runId: string, mode: AccessMode | undefined): void {
    this.deps.store.setRunMode(runId, mode);
    this.deps.emit('access.changed', {});
  }

  pending(): AccessRequest[] {
    return this.deps.broker.list();
  }

  answer(id: string, answer: AccessAnswer): boolean {
    return this.deps.broker.answer(id, answer);
  }

  /** Judges `actions` (the strictest wins) and, for 'ask', waits for the person. `via`: who asks (tools, claude, codex, acp). */
  async decide(scope: AccessScope, actions: readonly AccessAction[], via: string, signal?: AbortSignal): Promise<AccessDecision> {
    const access = this.effective(scope);
    if (!actions.length || (access.mode === 'full' && !hasRules(access.rules))) return { allow: true, message: '', verdict: { choice: 'allow', reason: 'full access' } };
    const input = { mode: access.mode, rules: access.rules, project: access.project, workspace: this.deps.workspace(), ...(this.deps.platform ? { platform: this.deps.platform } : {}) };
    const judged = actions.map((action) => ({ action, verdict: judge(input, action) }));
    const verdict = strictest(judged.map((entry) => entry.verdict));
    if (verdict.choice === 'allow') return { allow: true, message: '', verdict };
    const action = judged.find((entry) => entry.verdict === verdict)!.action;
    if (verdict.choice === 'deny') return { allow: false, message: `My access does not allow this: ${verdict.reason}. I do not try it another way; I tell the person what I need instead.`, verdict };
    const answer = await this.deps.broker.ask({
      agentId: scope.agentId, agentName: this.deps.agentName(scope.agentId), ...(scope.conversationId ? { conversationId: scope.conversationId } : {}), ...(scope.runId ? { runId: scope.runId } : {}),
      mode: access.mode, action, summary: actionSummary(action), reason: verdict.reason, ...(verdict.grant ? { always: grantText(verdict.grant) } : {}), via,
    }, signal);
    if (answer === 'always' && verdict.grant) {
      const own = this.own(scope.agentId);
      this.deps.store.setAgent(scope.agentId, { mode: own.mode, rules: withGrant(own.rules, verdict.grant) });
      this.deps.emit('access.changed', { agentId: scope.agentId });
    }
    if (answer === 'once' || answer === 'always') return { allow: true, message: '', verdict };
    if (answer === 'deny') return { allow: false, message: 'The person declined this step. I do not try it another way; I go on without it or ask what they want instead.', verdict };
    return { allow: false, message: 'Nobody answered the approval request for this step, so it did not run. I go on without it or ask the person.', verdict };
  }

  /** The tool registry's check of one of the app's own tools: undefined = it may run, else the refusal text. */
  async gateTool(tool: { name: string; category: string }, args: Record<string, unknown>, scope: AccessScope, signal?: AbortSignal): Promise<string | undefined> {
    if (this.unlimited(scope)) return undefined;
    const decision = await this.decide(scope, toolActions(tool, args), 'tools', signal);
    return decision.allow ? undefined : decision.message;
  }
}
