// Banked Codex rate-limit resets (B-044, accounts.useReset): redeems one through the Codex engine
// (account/rateLimitResetCredit/consume, app-server schema of codex-cli 0.162) with one idempotency
// key per attempt. An attempt stays open while it has no answer – an error or a timeout, after which
// the effect is unknown – and is one per account: trying again sends that attempt again (its key and
// the credit it named, whatever credit the person's click names now – the monitor may meanwhile have
// dropped a credit that attempt redeemed), so the provider never redeems it twice ('alreadyRedeemed'
// when it went through before); any answer ends the attempt. After an answer the limits are read
// again through the account check (the monitor's queue): the new state always comes from the
// provider, never from here.
// Owns: the open attempts (in memory) and the preconditions. Never: retries by itself, redeems
// without the person's confirmation (the UI asks; the RPC is owner-only) or writes limits itself.

import { randomUUID } from 'node:crypto';
import type { Account } from '../../shared/model/providers.ts';
import type { ResetOutcome } from '../../shared/api/methods-providers.ts';
import { WorkforceError } from '../../shared/errors.ts';

export const RESET_OUTCOMES: readonly ResetOutcome[] = ['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'];

/** The Codex engine's redemption hook (CodexEngine.consumeReset): the provider's outcome as sent. */
export interface ResetPort {
  consumeReset(account: Account, idempotencyKey: string, creditId?: string): Promise<unknown>;
}

export interface ResetDeps {
  get(id: string): Account | undefined;
  /** The Codex engine. */
  engine(): unknown;
  /** The account check that reads the limits again (resolves when it is done). */
  check(id: string): Promise<void>;
  newKey?: () => string;
}

export class Resets {
  private readonly deps: ResetDeps;
  /** Account id → its attempt that has no answer yet (the key and the credit it named). */
  private readonly open = new Map<string, { key: string; creditId?: string }>();

  constructor(deps: ResetDeps) { this.deps = deps; }

  /**
   * Redeems one reset of a Codex plan (`creditId`, else the provider's next one) and reads the limits
   * again. An open attempt of the account is sent again as it was (`creditId` is then not used).
   */
  async use(id: string, creditId?: string): Promise<ResetOutcome> {
    const account = this.deps.get(id);
    if (!account) throw new WorkforceError('not_found', 'This account does not exist.');
    if (account.provider !== 'codex' || account.auth !== 'cli') throw new WorkforceError('bad_request', 'Only a Codex plan has resets.');
    if (!account.enabled) throw new WorkforceError('bad_request', 'Turn this account on first.');
    const port = this.deps.engine() as Partial<ResetPort> | undefined;
    if (typeof port?.consumeReset !== 'function') throw new WorkforceError('unavailable', 'Codex is not available.');
    const open = this.open.get(id);
    const attempt = open ?? { key: (this.deps.newKey ?? randomUUID)(), ...(creditId ? { creditId } : {}) };
    this.open.set(id, attempt);
    const end = () => { if (this.open.get(id) === attempt) this.open.delete(id); };
    let answer: unknown;
    try { answer = await port.consumeReset(account, attempt.key, attempt.creditId); }
    catch (error) {
      // A definite refusal (Codex could not start, or has no such method) sent nothing this time: a new
      // attempt ends; an open one stays open – its earlier send may have gone through.
      if (error instanceof WorkforceError && error.code === 'unavailable') { if (!open) end(); throw error; }
      throw new WorkforceError('unknown_effect', 'Codex did not confirm the reset. Try again – this attempt is never used twice.', { cause: error });
    }
    end();
    await this.deps.check(id).catch(() => undefined);
    const outcome = RESET_OUTCOMES.find((known) => known === answer);
    if (!outcome) throw new WorkforceError('internal', 'Codex answered the reset in a way Autark does not know. Check the limits before trying again.');
    return outcome;
  }

  /** The account is gone: its open attempt ends. */
  forget(id: string): void {
    this.open.delete(id);
  }
}
