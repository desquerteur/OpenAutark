// B-044: the open data folder's one watcher as a member of RuntimeServices (merged by module augmentation,
// like the other late additions in this folder). Implemented by runtime/root/watcher.ts, created and started
// in compose/services.ts, closed by the compose/lifecycle.ts stop step 'data folder'.
// Owns: the member declaration only.

import type { RootWatcher } from '../root/watcher.ts';

declare module '../contracts.ts' {
  interface RuntimeServices {
    /** The one watcher on <data> (one recursive fs.watch; per owned folder where the system has no native tree watch): owners register their entry (agents, settings.json …); TextDoc writes are marked as the app's own. Missing = not wired (fakes). */
    rootWatcher?: RootWatcher;
  }
}

export type { RootWatcher };
