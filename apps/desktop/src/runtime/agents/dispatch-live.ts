// Live state the dispatcher publishes while agents work: the agent status ring/line
// (org.setStatus: working · waiting · idle), the `agent.activity` event ("who is working")
// and the host keep-awake lease while at least one turn runs (B-078, D17: with settings day.keepAwake – Settings › General
// "Keep the screen on while agents work" – the lease keeps the screen on too).
// Owns: those side effects and "never overwrite a pause". Never: decides what runs.

import type { OrgService, RuntimeServices } from '../contracts.ts';
import type { AgentStatus } from '../../shared/model/org.ts';
import type { AgentActivity } from '../../shared/model/runs.ts';
import { SCREEN_ON_REASON, daySettingsOf } from '../../shared/model/day-settings.ts';

type OrgWithActivity = OrgService & { setActivitySource?(source: () => AgentActivity[]): void };

export class LiveStatus {
  private readonly services: () => RuntimeServices;
  private readonly activity: () => AgentActivity[];
  /** True when org.setStatus already publishes agent.activity from our source. */
  private orgEmits = false;
  private releaseAwake?: () => void;

  constructor(services: () => RuntimeServices, activity: () => AgentActivity[]) {
    this.services = services;
    this.activity = activity;
  }

  /** Makes the org service read live activity from the dispatcher (when it supports that). */
  attach(): void {
    const org = this.services().org as OrgWithActivity;
    if (typeof org.setActivitySource === 'function') {
      org.setActivitySource(this.activity);
      this.orgEmits = true;
    }
  }

  /** Sets the agent's status (never over a pause) and makes sure agent.activity is published. */
  status(agentId: string, status: AgentStatus, note?: string): void {
    const services = this.services();
    let emitted = false;
    try {
      const agent = services.org.get(agentId);
      if (agent && agent.status !== 'paused') {
        services.org.setStatus(agentId, status, note);
        emitted = this.orgEmits;
      }
    } catch (error) {
      services.log.warn('agent status update failed', { agentId, error: String(error) });
    }
    if (!emitted) this.emit();
  }

  emit(): void {
    const services = this.services();
    try { services.bus.emit('agent.activity', { active: this.activity() }); } catch (error) {
      services.log.warn('activity event failed', { error: String(error) });
    }
  }

  /** Holds the host awake while turns run – with day.keepAwake (B-078) the screen stays on too; releases it when the last one ends. */
  awake(working: boolean): void {
    if (working && !this.releaseAwake) {
      const services = this.services();
      try {
        const screen = (() => { try { return daySettingsOf(services.settings.get()).keepAwake; } catch { return false; } })();
        if (typeof services.host?.keepAwake === 'function') this.releaseAwake = services.host.keepAwake(screen ? SCREEN_ON_REASON : 'Agents are working');
      } catch (error) {
        services.log.warn('keepAwake failed', { error: String(error) });
      }
    } else if (!working && this.releaseAwake) {
      const release = this.releaseAwake;
      this.releaseAwake = undefined;
      try { release(); } catch { /* host gone */ }
    }
  }
}
