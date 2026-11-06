// Connectors (B-052, B4): the service behind apps.* as an optional member of RuntimeServices (module augmentation,
// like the other late additions in this folder). Implemented by runtime/apps/service.ts (shape in apps/types.ts);
// wired in compose/services.ts. Missing = not wired (fakes): the RPC handlers answer 'unavailable'.
// Owns: the member declaration. Never: behaviour.

import type { AppsService } from '../apps/types.ts';

declare module '../contracts.ts' {
  interface RuntimeServices {
    /** The person's connectors (MCP servers, mailboxes – files in <data>/connectors); missing = not wired. */
    apps?: AppsService;
  }
}

export type { AppsService };
