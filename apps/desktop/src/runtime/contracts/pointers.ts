// B-055 Named pointers: the hub (runtime/pointers/hub.ts) as an optional member of RuntimeServices
// (module augmentation, like the other late additions in this folder). Wired in compose/network.ts.
// Missing = not wired (fakes): nothing is reported and agents read no pointer line.
// Owns: the member declaration. Never: behaviour.

import type { PointerHub } from '../pointers/hub.ts';

declare module '../contracts.ts' {
  interface RuntimeServices {
    /** B-055: who points where on shared surfaces (browsers, screens); in memory only. */
    pointers?: PointerHub;
  }
}
