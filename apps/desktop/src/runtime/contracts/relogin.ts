// Contract of the sign-in work (B-047 D10): a signed-out plan account becomes work – a task for an agent while
// another account can still run one, else a real to-do for the person – and that work closes itself once the
// account is usable again (runtime/accounts/relogin.ts).
// Adds the optional `RuntimeServices.relogin` by module augmentation (contracts.ts is a size hotspot), so
// existing fakes keep compiling; without it accounts/failure.ts sends its one notification as before.
// Owns: interface shapes only. Never: behaviour.

import type { Account } from '../../shared/model/providers.ts';

export interface ReloginService {
  /** A plan agents use was just found signed out (accounts/failure.ts, once per sign-out): create the sign-in work. */
  signedOut(account: Account): void;
}

declare module '../contracts.ts' {
  interface RuntimeServices {
    /** B-047 D10: sign-in work after a sign-out (compose/services.ts); missing = a notification only. */
    relogin?: ReloginService;
  }
}
