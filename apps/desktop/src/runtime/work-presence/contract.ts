// B-055 G (WORK-PRESENCE): the work presence (service.ts) as an optional member of RuntimeServices (module
// augmentation, like runtime/contracts/*). Wired in compose/services.ts. Missing = not wired (fakes): no prompt line.
// Owns: the member declaration. Never: behaviour.

import type { WorkPresence } from './service.ts';

declare module '../contracts.ts' {
  interface RuntimeServices {
    /** B-055: who is working on which file (in memory) – the "Working nearby" hint. */
    workPresence?: WorkPresence;
  }
}
