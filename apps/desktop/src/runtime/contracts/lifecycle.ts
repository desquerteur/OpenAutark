// LIFECYCLE: the data/privacy contract as members of RuntimeServices (merged by module augmentation,
// like the other late additions in this folder). B-044: the secret grant audit is gone.
// Owns: the member declarations only. Never: behaviour (privacy/service.ts, compose/data-lifecycle.ts).

import type { PrivacyService } from '../privacy/service.ts';

declare module '../contracts.ts' {
  interface RuntimeServices {
    /** LIFECYCLE: inventory, Forget cascade, retention and export (compose/data-lifecycle.ts). */
    privacy?: PrivacyService;
    /** LIFECYCLE: stops the listeners above (compose/lifecycle.ts). */
    dataLifecycle?: { stop(): void };
  }
}

export type { PrivacyService };
