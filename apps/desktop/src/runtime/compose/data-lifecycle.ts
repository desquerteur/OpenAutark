// Composition of the data lifecycle: the privacy service (retention of old knowledge versions, the provider
// histories – Claude Code purge on request) on the store and the late-bound accounts and engines.
// Owns: this wiring. Never: behaviour, timers or polling.

import type { RuntimeServices } from '../contracts.ts';
import '../contracts/lifecycle.ts';
import type { KnowledgeStore } from '../knowledge/service.ts';
import { PrivacyService } from '../privacy/service.ts';
import { NativeHistory } from '../privacy/native-history.ts';

export function createDataLifecycle(s: RuntimeServices, knowledge: KnowledgeStore): { stop(): void } {
  // Accounts and engines are built later: late-bound.
  const history = new NativeHistory({
    db: s.db, clock: s.clock, log: s.log, accountsRoot: s.paths.accounts,
    accounts: () => s.accounts?.list() ?? [], engine: (id) => { try { return s.engines?.get(id); } catch { return undefined; } },
  });
  const privacy = new PrivacyService({
    db: s.db, clock: s.clock, bus: s.bus, log: s.log, history,
    settings: () => { try { return s.settings.get(); } catch { return {}; } },
    purgeVersions: (ids) => knowledge.purgeVersions(ids),
  });
  s.privacy = privacy;
  privacy.start();
  const handle = { stop() { privacy.stop(); } };
  s.dataLifecycle = handle;
  return handle;
}
