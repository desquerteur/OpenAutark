// AF-013: the access service (modes, rules, approval requests) as a member of RuntimeServices (merged by module
// augmentation, like the other late additions in this folder). Implemented by runtime/access/service.ts, wired in
// compose/access.ts. Owns: the member declaration only.

import type { AccessService } from '../access/service.ts';

declare module '../contracts.ts' {
  interface RuntimeServices {
    /** AF-013: what each agent may do; missing = not wired (fakes) – every agent then has full access, as before. */
    access?: AccessService;
  }
}

export type { AccessService };
