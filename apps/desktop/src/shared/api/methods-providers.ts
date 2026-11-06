// RPC contract part: providers and routing – accounts (detect, add, log in/out, install, Codex
// resets, an endpoint test before adding), usage, the model catalog and policies, routing previews and the
// efforts a model offers. Handlers: runtime/rpc/handlers/providers.ts.
// Merged into Methods by module augmentation (split from methods.ts by area, 23.10.).
// Owns: these method and event shapes. Never: behaviour.

import type { UseNow } from '../model/models-uses.ts';
import type { Account, DetectionReport, Effort, ModelInfo, ModelPolicy, ProviderId, RouteDecision, UsageSummary } from '../model/providers.ts';

/** B-044: the answer of a Codex reset redemption (the app server's ConsumeAccountRateLimitResetCreditOutcome). */
export type ResetOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';

/**
 * B-051: one tiny real turn on an account ("does it answer?") – ok with the time and the model that answered,
 * else why not in words a person understands (`reason` for the UI's choice of next step).
 */
export type AccountTry =
  | { ok: true; ms: number; model: string }
  | { ok: false; reason: 'missing' | 'signed_out' | 'plan' | 'limit' | 'error'; message: string };

/** Result of `catalog.status`: catalog size, available models and the last full refresh. */
export interface ModelCatalogStatus {
  models: number;
  available: number;
  /** Last full catalog refresh (model lists of every account). */
  refreshedAt?: number;
}

declare module '../api/methods.ts' {
  interface Methods {
    // ----------------------------------------------------------------- providers & routing
    'accounts.list': { params: void; result: Account[] };
    'accounts.detect': { params: { force?: boolean } | void; result: DetectionReport };
    'accounts.add': { params: { provider: ProviderId; label?: string; apiKey?: string; baseUrl?: string; rotation?: boolean; envVar?: string; detected?: boolean }; result: Account & { signInUrl?: string } }; // apiKey: typed, or a handle secret://<id> of the catalog (the account then only names that entry); PR5: envVar = key variable name, detected = "Add again"; B-051: signInUrl = the page the CLI's sign-in printed (when it did within a few seconds)
    'accounts.update': { params: { id: string; label?: string; priority?: number; rotation?: boolean; enabled?: boolean }; result: Account };
    'accounts.login': { params: { id: string }; result: { started: boolean; url?: string } };
    'accounts.logout': { params: { id: string }; result: { ok: true } };
    'accounts.remove': { params: { id: string }; result: { ok: true } };
    'accounts.install': { params: { provider: 'claude' | 'codex' }; result: { ok: true } };
    /** B-051, owner: one tiny real tool-less turn on this account (first run's "Works – answered in 2 s"). */
    'accounts.try': { params: { id: string }; result: AccountTry };
    /** B-044 (MODELS-ACCOUNTS), owner: lists an API endpoint's model ids before it is saved; the key (typed, or a handle secret://<id>) is used for this call only. */
    'accounts.test': { params: { provider: ProviderId; baseUrl?: string; apiKey?: string }; result: { models: string[] } };
    /**
     * B-044 (MODELS-ACCOUNTS), owner, after the person confirmed: redeems one banked Codex rate-limit
     * reset (`creditId`, else the next available one). `outcome` is the Codex app server's answer
     * (account/rateLimitResetCredit/consume); 'alreadyRedeemed' = this attempt went through before.
     */
    'accounts.useReset': { params: { id: string; creditId?: string }; result: { outcome: ResetOutcome } };
    'usage.list': { params: { refresh?: boolean } | void; result: UsageSummary[] };
    'models.list': { params: { refresh?: boolean } | void; result: ModelInfo[] };
    /** Owner: what each model use resolves to right now (MODEL_USES order); Settings › Models shows it. */
    'models.uses': { params: void; result: UseNow[] };
    'models.recent': { params: { agentId?: string } | void; result: string[] };
    /** The stored policy at one scope (no ids = global default for agents); null when none is set. */
    'models.getPolicy': { params: { agentId?: string; conversationId?: string } | void; result: ModelPolicy | null };
    'models.setPolicy': { params: { agentId?: string; conversationId?: string; policy: ModelPolicy }; result: { ok: true } };
    /** RT5: like a turn, the chat's last done run is the previous choice; `ignorePin` = as on a picker's "nothing chosen" option (in a chat its own model/effort choice does not answer; without a chat the agent's own pin does not either). */
    'routing.preview': { params: { agentId: string; conversationId?: string; text?: string; mode?: string; ignorePin?: boolean }; result: RouteDecision };
    'catalog.refresh': { params: void; result: { ok: true; models: number; fetchedAt?: number; refreshedAt?: number } };
    'catalog.status': { params: void; result: ModelCatalogStatus };

    // ----------------------------------------------------------------- effort helpers for the UI
    'efforts.forModel': { params: { modelId: string }; result: Effort[] };
  }
}
