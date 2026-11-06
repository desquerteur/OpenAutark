// A sign-out becomes work (B-047 D10). accounts/failure.ts reports a plan account agents use that was just found
// signed out (once per sign-out – by an agent turn, or by a helper call through the account service this one is
// attached to, watch()); then
// - while another account can still run an agent: ONE task "Sign in to <label> again" for the origin Manager
//   (else any manager, else an agent in computer mode), chat-free (B-054: a task needs no chat; no 1:1, no hidden
//   work chat – the run is on the task, origin system "Account signed out"):
//   accounts.sign_in starts the official CLI sign-in, the agent finishes the page itself, and only a password,
//   2FA code or another check only the person can pass becomes a prepared to-do;
// - with no usable account left (nobody could run that task), no agent to give it to, or after MAX_PER_DAY
//   tasks for the account within a day (a sign-in that keeps failing): a real, chat-free to-do for the person on
//   My day ("Sign in in Settings › Models"), which the task lifecycle notifies once.
// The work closes itself: an account.upserted that shows the account usable again completes the open task or
// to-do as the system (verified by the account state); the account removed or switched off cancels it.
// State: kv namespace 'relogin', per account { taskId, times } (the open work and the creation times of the day).
// Owns: choosing who does the sign-in, creating and closing that work, the cap. Never: types a password, reads
// tokens or CLI homes, starts a sign-in itself (accounts.sign_in does, on the agent's call), creates a second
// open task for the same account, creates a chat for the work, or throws into the turn that found the sign-out.

import { SYSTEM_ID } from '../../shared/ids.ts';
import { ORIGINS, type Origin } from '../../shared/model/origin.ts';
import type { Account } from '../../shared/model/providers.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { ReloginService } from '../contracts/relogin.ts';
import { isHealthy } from './candidates.ts';
import { attachRelogin } from './failure.ts';
import { cleanLabel } from '../context/setup-facts.ts';

export const RELOGIN_NS = 'relogin';
/** Sign-in tasks for one account within DAY_MS before the person gets the to-do instead. */
export const MAX_PER_DAY = 3;
const DAY_MS = 24 * 3600_000;
const OPEN: ReadonlySet<TaskView['status']> = new Set(['open', 'working', 'waiting', 'needs_you', 'blocked']);
/** Why the sign-in work exists (both the agent's task and the person's to-do). */
export const RELOGIN_ORIGIN: Origin = { source: ORIGINS.system.source, label: 'Account signed out' };

interface Entry { taskId?: string; times: number[] }

const PROVIDERS: Record<string, string> = { codex: 'Codex', claude: 'Claude Code' };
const providerName = (account: Account): string => PROVIDERS[account.provider] ?? account.provider;
const labelOf = (account: Account): string => cleanLabel(account.label, account.email);

export function signInTaskTitle(account: Account): string {
  return `Sign in to ${labelOf(account)} again`;
}

/** The agent task's notes: what happened and the way through (no procedure beyond the tool and the boundary). */
export function agentNotes(account: Account): string {
  return [
    `${labelOf(account)} (${providerName(account)}) was signed out, so agents cannot use it until it is signed in again.`,
    `accounts.sign_in with accountId "${account.id}" starts the official ${providerName(account)} sign-in on this PC; it opens the sign-in page in this PC's default browser. I finish what I can there myself (screen tools, or a colleague in browser or computer mode).`,
    'I type no password myself; a password, a 2FA code or another check only the person can pass becomes a short, prepared to-do for them (human.ask, humanReason credential).',
    'This task closes itself as soon as the account works again.',
  ].join('\n');
}

export function humanNotes(account: Account, why: 'no_account' | 'no_agent' | 'capped'): string {
  const reason = why === 'no_account' ? 'No other model account can run the team right now, so the agents wait for it.'
    : why === 'capped' ? `The team tried to sign it in again ${MAX_PER_DAY} times today without success.`
      : 'No agent can take over the sign-in right now.';
  return `${labelOf(account)} (${providerName(account)}) was signed out. ${reason} Sign in again in Settings › Models – it takes a minute. This to-do closes itself once the account works again.`;
}

export class Relogin implements ReloginService {
  private readonly services: () => RuntimeServices;

  constructor(deps: { services: () => RuntimeServices }) {
    this.services = deps.services;
  }

  signedOut(account: Account): void {
    const s = this.services();
    try { this.create(s, account); } catch (error) {
      s.log.warn('sign-in work not created', { accountId: account.id, error: String(error) });
    }
  }

  /**
   * Closes the work when an account becomes usable again, removed or switched off, and attaches this service to the
   * runtime's account service (failure.ts attachRelogin: helper calls report their sign-outs here too); returns the
   * unsubscribe function.
   */
  watch(): () => void {
    const s = this.services();
    const offs = [
      s.bus.on('account.upserted', (account) => this.settle(account)),
      s.bus.on('account.removed', ({ id }) => this.cancel(id, 'The account was removed.')),
    ];
    if (s.accounts && typeof s.accounts === 'object') offs.push(attachRelogin(s.accounts, this));
    return () => { for (const off of offs.splice(0)) off(); };
  }

  /** The account's open sign-in work, if any (tests and the tool's answer). */
  openWork(accountId: string): TaskView | undefined {
    const s = this.services();
    const id = this.entry(s, accountId)?.taskId;
    const task = id ? s.tasks.get(id) : undefined;
    return task && OPEN.has(task.status) ? task : undefined;
  }

  private create(s: RuntimeServices, account: Account): void {
    if (this.openWork(account.id)) return; // one open sign-in task per account
    const now = s.clock.now();
    const times = (this.entry(s, account.id)?.times ?? []).filter((at) => now - at < DAY_MS);
    const otherUsable = s.accounts.list().some((other) => other.id !== account.id && isHealthy(other, now));
    const agent = otherUsable && times.length < MAX_PER_DAY ? signInAgent(s) : undefined;
    const why = !otherUsable ? 'no_account' : times.length >= MAX_PER_DAY ? 'capped' : 'no_agent';
    const key = `relogin:${account.id}:${now}:${times.length}`; // one task per sign-out (a repeat of the same call finds it)
    const task = agent ? this.agentTask(s, account, agent, key) : this.humanTodo(s, account, why, key);
    this.save(s, account.id, { taskId: task.id, times: [...times, now] });
  }

  private agentTask(s: RuntimeServices, account: Account, agent: Agent, clientId: string): TaskView {
    return s.tasks.create({
      origin: RELOGIN_ORIGIN, title: signInTaskTitle(account), notes: agentNotes(account),
      assigneeKind: 'agent', assigneeId: agent.id, priority: 1, createdBy: SYSTEM_ID, clientId,
    });
  }

  private humanTodo(s: RuntimeServices, account: Account, why: 'no_account' | 'no_agent' | 'capped', clientId: string): TaskView {
    // The task lifecycle notifies the person of a new to-do (kind 'todo', naming it) – no second notification.
    return s.tasks.create({
      origin: RELOGIN_ORIGIN, title: signInTaskTitle(account), notes: humanNotes(account, why),
      assigneeKind: 'human', humanReason: 'credential', createdBy: SYSTEM_ID, clientId,
    });
  }

  private settle(account: Account): void {
    const s = this.services();
    try {
      if (account.enabled === false) { this.cancel(account.id, 'The account was switched off.'); return; }
      if (!isHealthy(account, s.clock.now())) return;
      const task = this.openWork(account.id);
      if (!task) return;
      s.tasks.complete(task.id, {
        summary: `${labelOf(account)} works again.`,
        evidence: [{ kind: 'check', label: `Account state: ${account.state}` }],
        verification: 'verified',
      }, SYSTEM_ID);
      this.save(s, account.id, { times: this.entry(s, account.id)?.times ?? [] });
    } catch (error) {
      s.log.warn('closing the sign-in work failed', { accountId: account.id, error: String(error) });
    }
  }

  private cancel(accountId: string, note: string): void {
    const s = this.services();
    try {
      const task = this.openWork(accountId);
      if (task) s.tasks.setStatus(task.id, 'cancelled', SYSTEM_ID, note);
      if (task) this.save(s, accountId, { times: this.entry(s, accountId)?.times ?? [] });
    } catch (error) {
      s.log.warn('cancelling the sign-in work failed', { accountId, error: String(error) });
    }
  }

  private entry(s: RuntimeServices, accountId: string): Entry | undefined {
    const row = s.db.get<{ value: string }>('SELECT value FROM kv WHERE ns = ? AND key = ?', [RELOGIN_NS, accountId]);
    if (!row) return undefined;
    try { return JSON.parse(row.value) as Entry; } catch { return undefined; }
  }

  private save(s: RuntimeServices, accountId: string, entry: Entry): void {
    s.db.run(
      `INSERT INTO kv (ns, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [RELOGIN_NS, accountId, JSON.stringify(entry), s.clock.now()],
    );
  }
}

/** Who signs in: the origin Manager (no manager of its own), else any manager, else an agent in computer mode. */
export function signInAgent(s: Pick<RuntimeServices, 'org'>): Agent | undefined {
  const active = s.org.list().filter((agent) => !agent.archivedAt && agent.status !== 'paused');
  return active.find((agent) => agent.mode === 'manager' && !agent.managerId)
    ?? active.find((agent) => agent.mode === 'manager')
    ?? active.find((agent) => agent.mode === 'computer');
}
